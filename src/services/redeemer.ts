/**
 * Automatic redemption of resolved positions (live mode).
 *
 * Every REDEEM_INTERVAL_MS the redeemer asks Polymarket's data API for the
 * wallet's redeemable positions, and for each resolved market whose winning
 * shares are worth at least REDEEM_MIN_PAYOUT_USD it:
 *   1. checks on-chain that the condition is resolved,
 *   2. simulates the routed redeem transaction and measures the pUSD payout,
 *   3. sends it from the signing key (which pays gas in POL) and waits for the receipt.
 * Nothing is sent when the simulation fails or would pay nothing (for example
 * when Polymarket's own Auto-Redeem got there first).
 */

import type { Account, PublicClient, WalletClient } from "viem" with { "resolution-mode": "import" };
import type { Config } from "../config";
import {
  CTF_ABI,
  ERC20_BALANCE_ABI,
  REDEEM_CONTRACTS,
  SAFE_ABI,
  approveAdapterCall,
  buildRoutedTx,
  redeemCall,
  routeForSignatureType,
  selectRedeemable,
  type DataApiPosition,
  type Hex,
  type RedeemCandidate,
  type TxRequest,
  type WalletRoute,
} from "../execution/redeem";
import { fetchJson } from "../utils/http";
import { Journal } from "./journal";
import { logError, logInfo, logWarn } from "../utils/logger";

const DATA_API = "https://data-api.polymarket.com";
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
const MIN_GAS_BALANCE_POL = 0.05;

export interface RedeemOutcome {
  candidate: RedeemCandidate;
  status: "redeemed" | "simulated" | "skipped" | "failed";
  payout?: number;
  txHash?: string;
  reason?: string;
}

interface Simulation {
  ok: boolean;
  /** Measured pUSD increase of the holder, or null if the RPC cannot simulate with state. */
  payout: number | null;
  gas?: bigint;
  error?: string;
}

export class Redeemer {
  private pub!: PublicClient;
  private wallet!: WalletClient;
  private account!: Account;
  private route!: WalletRoute;
  private holder!: Hex;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private canSimulateCalls = true;
  private readonly retryAfter = new Map<string, number>();

  constructor(
    private readonly cfg: Config,
    private readonly journal: Journal | null,
  ) {}

  /**
   * Prepare clients and check the wallet; returns false if auto-redeem cannot
   * run for this wallet. With `dryRun` a missing adapter approval is only reported.
   */
  async init(dryRun = false): Promise<boolean> {
    const route = routeForSignatureType(this.cfg.signatureType);
    if (!route) {
      logWarn(
        "Auto-redeem is not supported for this wallet type (deposit wallet). " +
          "Enable Auto-Redeem on polymarket.com (Settings -> Trading) instead.",
      );
      return false;
    }
    this.route = route;

    const { createPublicClient, createWalletClient, http, formatEther } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { polygon } = await import("viem/chains");
    const key = (this.cfg.privateKey.startsWith("0x") ? this.cfg.privateKey : `0x${this.cfg.privateKey}`) as Hex;
    this.account = privateKeyToAccount(key);
    this.pub = createPublicClient({ chain: polygon, transport: http(this.cfg.rpcUrl) }) as PublicClient;
    this.wallet = createWalletClient({ account: this.account, chain: polygon, transport: http(this.cfg.rpcUrl) });
    this.holder = (route === "eoa" ? this.account.address : this.cfg.funderAddress) as Hex;

    const gas = Number(formatEther(await this.pub.getBalance({ address: this.account.address })));
    if (gas < MIN_GAS_BALANCE_POL) {
      logWarn(
        `Auto-redeem: signing key ${this.account.address} has ${gas.toFixed(4)} POL; ` +
          `send ~${MIN_GAS_BALANCE_POL} POL there to pay for redeem transactions.`,
      );
    }

    await this.checkWallet(dryRun);
    logInfo(`Auto-redeem ready: ${route} wallet ${this.holder}, every ${Math.round(this.cfg.redeemIntervalMs / 1000)}s`);
    return true;
  }

  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.cfg.redeemIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Make sure the holder is the wallet we think it is and that the adapter may move its tokens. */
  private async checkWallet(dryRun: boolean): Promise<void> {
    if (this.route === "safe") {
      const [owners, threshold] = await Promise.all([
        this.pub.readContract({ address: this.holder, abi: SAFE_ABI, functionName: "getOwners" }),
        this.pub.readContract({ address: this.holder, abi: SAFE_ABI, functionName: "getThreshold" }),
      ]);
      const isOwner = owners.some((o) => o.toLowerCase() === this.account.address.toLowerCase());
      if (!isOwner || threshold !== 1n) {
        throw new Error(`POLY_FUNDER ${this.holder} is not a 1-of-1 Safe owned by ${this.account.address}`);
      }
    } else if (this.route === "proxy") {
      const code = (await this.pub.getCode({ address: this.holder })) ?? "0x";
      const impl = REDEEM_CONTRACTS.proxyImplementation.slice(2).toLowerCase();
      if (!code.toLowerCase().includes(impl)) {
        logWarn(`POLY_FUNDER ${this.holder} does not look like a Polymarket proxy wallet; redeem simulations will tell`);
      }
    }

    const approved = await this.pub.readContract({
      address: REDEEM_CONTRACTS.conditionalTokens,
      abi: CTF_ABI,
      functionName: "isApprovedForAll",
      args: [this.holder, REDEEM_CONTRACTS.ctfCollateralAdapter],
    });
    if (approved) return;
    if (dryRun) {
      logWarn("Auto-redeem: the CTF collateral adapter is not approved for this wallet yet (sent automatically in live mode)");
      return;
    }

    logInfo("Auto-redeem: approving the CTF collateral adapter to redeem outcome tokens (one-time transaction)");
    const tx = await buildRoutedTx(this.route, this.holder, this.account.address, await approveAdapterCall());
    const hash = await this.send(tx);
    logInfo(`Adapter approval sent: ${hash}`);
  }

  /** One pass over redeemable positions. With `dryRun` nothing is sent. */
  async runOnce(dryRun = false): Promise<RedeemOutcome[]> {
    if (this.running) return [];
    this.running = true;
    const outcomes: RedeemOutcome[] = [];
    try {
      const positions = await this.fetchRedeemable();
      const candidates = selectRedeemable(positions, {
        assets: this.cfg.assets,
        scope: this.cfg.redeemScope,
        minPayoutUsd: this.cfg.redeemMinPayoutUsd,
      });
      const now = Date.now();
      for (const c of candidates) {
        if ((this.retryAfter.get(c.conditionId) ?? 0) > now) continue;
        const outcome = await this.redeemOne(c, dryRun);
        outcomes.push(outcome);
        if (outcome.status === "failed" || outcome.status === "skipped") {
          this.retryAfter.set(c.conditionId, Date.now() + RETRY_AFTER_FAILURE_MS);
        }
      }
    } catch (err) {
      logWarn(`Auto-redeem pass failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
    return outcomes;
  }

  private async fetchRedeemable(): Promise<DataApiPosition[]> {
    const all: DataApiPosition[] = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const page = await fetchJson<DataApiPosition[]>(
        `${DATA_API}/positions?user=${this.holder}&redeemable=true&sizeThreshold=0&limit=500&offset=${offset}`,
      );
      all.push(...page);
      if (page.length < 500) break;
    }
    return all;
  }

  private async redeemOne(c: RedeemCandidate, dryRun: boolean): Promise<RedeemOutcome> {
    const label = `${c.slug || c.conditionId} (${c.shares.toFixed(2)} shares, ~${c.expectedPayout.toFixed(2)} pUSD)`;
    const denominator = await this.pub.readContract({
      address: REDEEM_CONTRACTS.conditionalTokens,
      abi: CTF_ABI,
      functionName: "payoutDenominator",
      args: [c.conditionId],
    });
    if (denominator === 0n) return { candidate: c, status: "skipped", reason: "not resolved on-chain yet" };

    const tx = await buildRoutedTx(this.route, this.holder, this.account.address, await redeemCall(c.conditionId));
    const sim = await this.simulate(tx);
    if (!sim.ok) {
      logWarn(`Auto-redeem: simulation failed for ${label}: ${sim.error}`);
      return { candidate: c, status: "failed", reason: sim.error };
    }
    if (sim.payout !== null && sim.payout < 0.005) {
      const reason = c.expectedPayout < 0.005 ? "only losing shares, nothing to collect" : "simulation pays nothing (already redeemed?)";
      return { candidate: c, status: "skipped", reason };
    }
    const payout = sim.payout ?? c.expectedPayout;
    if (dryRun) return { candidate: c, status: "simulated", payout };

    try {
      const hash = await this.send(tx);
      logInfo(`[REDEEMED] ${label}: +${payout.toFixed(2)} pUSD, tx ${hash}`);
      this.journal?.write("redemptions", { conditionId: c.conditionId, slug: c.slug, shares: c.shares, payout, txHash: hash, route: this.route });
      return { candidate: c, status: "redeemed", payout, txHash: hash };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logError(`Auto-redeem: transaction failed for ${label}: ${reason}`);
      this.journal?.write("redemptions", { conditionId: c.conditionId, slug: c.slug, status: "failed", reason });
      return { candidate: c, status: "failed", reason };
    }
  }

  /** Run the transaction against current state; measure the holder's pUSD change where the RPC allows. */
  private async simulate(tx: TxRequest): Promise<Simulation> {
    const { encodeFunctionData } = await import("viem");
    if (this.canSimulateCalls) {
      const balanceCall = {
        to: REDEEM_CONTRACTS.collateral as Hex,
        data: encodeFunctionData({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [this.holder] }),
      };
      try {
        const res = await this.pub.simulateCalls({ account: this.account.address, calls: [balanceCall, tx, balanceCall] });
        const [before, exec, after] = res.results;
        if (exec.status !== "success") return { ok: false, payout: null, error: exec.error?.message ?? "reverted" };
        const payout = Number(BigInt(after.data) - BigInt(before.data)) / 1e6;
        return { ok: true, payout, gas: exec.gasUsed };
      } catch (err) {
        // RPCs without eth_simulateV1: fall back to a plain gas estimate.
        logWarn(`RPC cannot simulate with state (${err instanceof Error ? err.message.split("\n")[0] : err}); using eth_estimateGas`);
        this.canSimulateCalls = false;
      }
    }
    try {
      const gas = await this.pub.estimateGas({ account: this.account.address, to: tx.to, data: tx.data });
      return { ok: true, payout: null, gas };
    } catch (err) {
      return { ok: false, payout: null, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
    }
  }

  private async send(tx: TxRequest): Promise<Hex> {
    const hash = await this.wallet.sendTransaction({ account: this.account, chain: this.wallet.chain, to: tx.to, data: tx.data });
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return hash;
  }
}
