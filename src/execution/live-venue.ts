/**
 * Live order routing through Polymarket's CLOB (V2) using the official
 * @polymarket/clob-client-v2 SDK for EIP-712 order signing and API-key auth.
 *
 * Orders are posted with a thin HTTP call instead of `client.postOrders`,
 * because the SDK waits (up to 30 s) for on-chain settlement of matched trades
 * before returning, which is too slow to repair a one-sided fill.
 */

import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  createL2Headers,
  isV2Order,
  orderToJsonV1,
  orderToJsonV2,
  type ApiKeyCreds,
  type SignedOrder,
  type SignatureTypeV2,
  type TickSize,
} from "@polymarket/clob-client-v2";

import type { LegFill, MarketInfo } from "../types";
import { feePerShare, roundFee } from "../core/fees";
import { emptyFill, type OrderRequest, type TimeInForce, type Venue } from "./venue";
import { logDebug, logInfo, logWarn } from "../utils/logger";

type ClobSigner = NonNullable<ConstructorParameters<typeof ClobClient>[0]["signer"]>;

const CLOB_HOST = "https://clob.polymarket.com";
const SHARE_DECIMALS = 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LiveVenueConfig {
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
  rpcUrl: string;
  apiCreds?: ApiKeyCreds;
}

interface RawOrderResponse {
  success?: boolean;
  errorMsg?: string;
  error?: string;
  orderID?: string;
  status?: string;
  makingAmount?: string;
  takingAmount?: string;
  tradeIDs?: string[];
}

/**
 * Parse an amount from an order response. The API returns decimal strings;
 * if a value looks like 6-decimal base units, scale it down.
 */
function parseAmount(raw: string | undefined, expectedMax: number): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > expectedMax * 1000 ? n / SHARE_DECIMALS : n;
}

export class LiveVenue implements Venue {
  readonly mode = "live" as const;
  private client!: ClobClient;
  private signer!: ClobSigner;
  private creds!: ApiKeyCreds;
  /** Conditional-token balances (shares) seen before this process traded them. */
  private readonly baseline = new Map<string, number>();

  constructor(private readonly cfg: LiveVenueConfig) {}

  async init(): Promise<void> {
    // viem is ESM-only; load it dynamically from this CommonJS build.
    const { createWalletClient, http } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { polygon } = await import("viem/chains");
    const key = this.cfg.privateKey.startsWith("0x") ? this.cfg.privateKey : `0x${this.cfg.privateKey}`;
    const account = privateKeyToAccount(key as `0x${string}`);
    this.signer = createWalletClient({ account, chain: polygon, transport: http(this.cfg.rpcUrl) });
    const signatureType = this.cfg.signatureType as SignatureTypeV2;
    const funderAddress = this.cfg.funderAddress || undefined;

    let creds = this.cfg.apiCreds;
    if (!creds) {
      const l1 = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: this.signer, signatureType, funderAddress });
      creds = await l1.createOrDeriveApiKey();
      if (!creds?.key || !creds.secret || !creds.passphrase) {
        throw new Error(`Could not create or derive CLOB API key: ${JSON.stringify(creds)}`);
      }
      logInfo("Derived CLOB API credentials from the wallet (set CLOB_API_KEY/SECRET/PASSPHRASE to reuse them)");
    }
    this.creds = creds;
    this.client = new ClobClient({
      host: CLOB_HOST,
      chain: Chain.POLYGON,
      signer: this.signer,
      creds,
      signatureType,
      funderAddress,
      throwOnError: true,
    });

    const version = await this.client.getVersion();
    const collateral = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    logInfo(
      `Live trading as ${account.address}${funderAddress ? ` (funder ${funderAddress})` : ""}, ` +
        `signature type ${signatureType}, CLOB order version ${version}, collateral balance ${(Number(collateral.balance) / 1e6).toFixed(2)} USDC`,
    );
  }

  async prepareMarket(market: MarketInfo): Promise<void> {
    await this.client.getClobMarketInfo(market.conditionId);
    for (const tokenId of [market.upTokenId, market.downTokenId]) {
      if (!this.baseline.has(tokenId)) this.baseline.set(tokenId, await this.tokenBalance(tokenId));
    }
  }

  async buyPair(up: OrderRequest, down: OrderRequest): Promise<[LegFill, LegFill]> {
    const [upOrder, downOrder] = await Promise.all([this.sign(up, Side.BUY), this.sign(down, Side.BUY)]);
    let responses: RawOrderResponse[];
    try {
      responses = await this.post("/orders", [
        { order: upOrder, orderType: OrderType.FOK },
        { order: downOrder, orderType: OrderType.FOK },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [emptyFill(up, "BUY", "error", msg), emptyFill(down, "BUY", "error", msg)];
    }
    return Promise.all([this.toFill(up, "BUY", responses[0]), this.toFill(down, "BUY", responses[1])]);
  }

  async buy(req: OrderRequest, tif: TimeInForce): Promise<LegFill> {
    return this.single(req, Side.BUY, tif);
  }

  async sell(req: OrderRequest, tif: TimeInForce): Promise<LegFill> {
    // Make sure the CLOB sees the freshly bought tokens before selling them.
    await this.client
      .updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: req.tokenId })
      .catch((err) => logDebug(`updateBalanceAllowance failed: ${String(err)}`));
    return this.single(req, Side.SELL, tif);
  }

  async reconcile(expected: Map<string, number>): Promise<string | null> {
    const problems: string[] = [];
    for (const [tokenId, shares] of expected) {
      const actual = (await this.tokenBalance(tokenId)) - (this.baseline.get(tokenId) ?? 0);
      if (Math.abs(actual - shares) > 0.5) {
        problems.push(`token ${tokenId.slice(0, 10)}…: expected ${shares.toFixed(2)} shares, exchange shows ${actual.toFixed(2)}`);
      }
    }
    return problems.length > 0 ? problems.join("; ") : null;
  }

  private async tokenBalance(tokenId: string): Promise<number> {
    const res = await this.client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
    return Number(res.balance) / SHARE_DECIMALS;
  }

  private async single(req: OrderRequest, side: Side, tif: TimeInForce): Promise<LegFill> {
    const sideName = side === Side.BUY ? "BUY" : "SELL";
    try {
      const order = await this.sign(req, side);
      const [res] = await this.post("/order", [{ order, orderType: tif === "FOK" ? OrderType.FOK : OrderType.FAK }]);
      return await this.toFill(req, sideName, res);
    } catch (err) {
      return emptyFill(req, sideName, "error", err instanceof Error ? err.message : String(err));
    }
  }

  private sign(req: OrderRequest, side: Side): Promise<SignedOrder> {
    return this.client.createOrder(
      { tokenID: req.tokenId, price: req.limitPrice, size: req.shares, side },
      { tickSize: String(req.tickSize) as TickSize, negRisk: req.negRisk },
    );
  }

  /** POST /order (one order) or /orders (batch) with L2 auth; returns one response per order. */
  private async post(path: "/order" | "/orders", orders: Array<{ order: SignedOrder; orderType: OrderType }>): Promise<RawOrderResponse[]> {
    const payloads = orders.map(({ order, orderType }) =>
      isV2Order(order)
        ? orderToJsonV2(order, this.creds.key, orderType, false, false)
        : orderToJsonV1(order as never, this.creds.key, orderType, false, false),
    );
    const body = JSON.stringify(path === "/order" ? payloads[0] : payloads);
    const headers = await createL2Headers(this.signer, this.creds, { method: "POST", requestPath: path, body });
    const res = await fetch(`${CLOB_HOST}${path}`, {
      method: "POST",
      headers: { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])), "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      // A rejected batch may still carry per-order results.
      if (Array.isArray(json)) return json as RawOrderResponse[];
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const list = Array.isArray(json) ? (json as RawOrderResponse[]) : [json as RawOrderResponse];
    while (list.length < orders.length) list.push({ success: false, errorMsg: "missing response" });
    return list;
  }

  private async toFill(req: OrderRequest, side: "BUY" | "SELL", res: RawOrderResponse | undefined): Promise<LegFill> {
    const base = emptyFill(req, side, "unknown");
    if (!res) return { ...base, status: "error", error: "no response" };
    const status = (res.status ?? "").toLowerCase();
    const errorMsg = res.errorMsg || res.error;
    base.orderId = res.orderID;
    if (res.success === false || (errorMsg && status !== "matched")) {
      return { ...base, status: status || "rejected", error: errorMsg || "rejected" };
    }

    let shares = 0;
    let usdc = 0;
    if (status === "matched") {
      // BUY: making = USDC paid, taking = shares received. SELL: the reverse.
      const making = parseAmount(res.makingAmount, req.shares);
      const taking = parseAmount(res.takingAmount, req.shares);
      shares = (side === "BUY" ? taking : making) ?? req.shares;
      usdc = (side === "BUY" ? making : taking) ?? shares * req.limitPrice;
    } else if (status === "delayed" && res.orderID) {
      const final = await this.awaitDelayed(res.orderID);
      shares = final.sizeMatched;
      // Fill prices are unknown here; the limit price bounds them.
      usdc = shares * req.limitPrice;
      if (shares === 0) return { ...base, status: final.status || "killed" };
    } else {
      if (status === "live" && res.orderID) {
        // An immediate-or-cancel order should never rest; cancel defensively.
        await this.client.cancelOrder({ orderID: res.orderID }).catch(() => undefined);
      }
      return { ...base, status: status || "unmatched" };
    }

    const avg = shares > 0 ? usdc / shares : req.limitPrice;
    return {
      ...base,
      sharesFilled: shares,
      cost: usdc,
      fee: roundFee(shares * feePerShare(avg, req.fee)),
      status: "matched",
    };
  }

  /** Crypto markets apply a short taker delay; poll until the order resolves. */
  private async awaitDelayed(orderId: string): Promise<{ status: string; sizeMatched: number }> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await sleep(150);
      try {
        const o = await this.client.getOrder(orderId);
        const status = (o?.status ?? "").toLowerCase();
        if (status && status !== "delayed" && status !== "live") {
          return { status, sizeMatched: Number(o.size_matched) || 0 };
        }
      } catch (err) {
        logDebug(`getOrder(${orderId}) failed: ${String(err)}`);
      }
    }
    logWarn(`Order ${orderId} still delayed after 5s; treating as unfilled and cancelling`);
    await this.client.cancelOrder({ orderID: orderId }).catch(() => undefined);
    return { status: "timeout", sizeMatched: 0 };
  }
}
