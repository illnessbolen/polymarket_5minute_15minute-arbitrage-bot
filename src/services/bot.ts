/**
 * Orchestrates discovery, market data, detection, execution, risk and settlement.
 *
 * Lifecycle per asset and 15-minute window [S, S+900):
 *   S        load the 15m market and the aligned 5m market [S+600, S+900),
 *            subscribe to their order books, capture the 15m strike (TWAP at S)
 *   S+600    capture the 5m strike (TWAP at S+600); start evaluating
 *   S+900-x  stop opening trades (NO_TRADE_LAST_SECONDS)
 *   S+900    roll to the next window; settle this one once Gamma resolves it
 */

import type { Config } from "../config";
import type { MarketInfo, Opportunity, TradeResult } from "../types";
import { bestPairCost, findOpportunity, type MarketQuotes } from "../core/arbitrage";
import { eventSlug, pairWindowAt, type PairWindow } from "../core/windows";
import { GammaClient } from "../feeds/gamma";
import { MarketStream } from "../feeds/market-stream";
import { ChainlinkTwapFeed, assetSymbol } from "../feeds/chainlink-twap";
import { TradeExecutor } from "../execution/executor";
import type { Venue } from "../execution/venue";
import { Journal } from "./journal";
import { RiskManager } from "./risk";
import { WindowLedger } from "./positions";
import { logDebug, logError, logInfo, logWarn } from "../utils/logger";

const MIN_EVAL_INTERVAL_MS = 50;
const SETTLE_DELAY_MS = 90_000;
const SETTLE_POLL_MS = 30_000;
const SETTLE_GIVE_UP_MS = 45 * 60_000;

interface WindowStats {
  lastPairCost: number | null;
  minPairCost: number | null;
  opportunities: number;
  trades: number;
  lastBlock: string | null;
}

interface PairState {
  asset: string;
  key: string;
  window: PairWindow;
  m5: MarketInfo | null;
  m15: MarketInfo | null;
  lastLoadAttempt: number;
  beat5m: number | null;
  beat15m: number | null;
  beatSource: { "5m": string | null; "15m": string | null };
  lastGammaBeatAttempt: number;
  busy: boolean;
  evalTimer: NodeJS.Timeout | null;
  lastEvalAt: number;
  stats: WindowStats;
}

interface SettlementJob {
  state: PairState;
  dueAt: number;
  giveUpAt: number;
}

const fmt = (x: number | null | undefined, d = 4): string => (x === null || x === undefined ? "—" : x.toFixed(d));
const hhmm = (sec: number): string => new Date(sec * 1000).toISOString().slice(11, 16);
const fmtStrike = (x: number | null): string => (x === null ? "—" : x.toFixed(Math.abs(x) < 10 ? 6 : 2));

export class ArbitrageBot {
  private readonly gamma: GammaClient;
  private readonly stream = new MarketStream();
  private readonly twap: ChainlinkTwapFeed;
  private readonly executor: TradeExecutor;
  private readonly risk: RiskManager;
  private readonly journal: Journal;
  private readonly pairs = new Map<string, PairState>();
  private readonly tokenIndex = new Map<string, { asset: string; market: MarketInfo }>();
  private readonly ledgers = new Map<string, WindowLedger>();
  private readonly settlements: SettlementJob[] = [];
  private loopTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private subsTimer: NodeJS.Timeout | null = null;
  private settling = false;
  private totals = { trades: 0, settledPnl: 0, settledWindows: 0 };

  constructor(
    private readonly cfg: Config,
    private readonly venue: Venue,
  ) {
    this.gamma = new GammaClient(cfg.defaultFee);
    this.twap = new ChainlinkTwapFeed(new Set(cfg.assets.map(assetSymbol)));
    this.risk = new RiskManager(cfg);
    this.journal = new Journal(cfg.logDir);
    this.executor = new TradeExecutor(
      venue,
      (id) => this.stream.book(id),
      (id) => this.tokenIndex.get(id)?.market,
      cfg,
    );
  }

  book(tokenId: string) {
    return this.stream.book(tokenId);
  }

  async start(): Promise<void> {
    logInfo(
      `Starting ${this.cfg.mode.toUpperCase()} arbitrage bot for ${this.cfg.assets.join(", ")} ` +
        `(min edge ${this.cfg.minEdge}/share, max $${this.cfg.maxUsdPerTrade}/trade, $${this.cfg.maxUsdPerWindow}/window)`,
    );
    await this.venue.init();
    this.stream.on("update", (tokenId) => {
      const entry = this.tokenIndex.get(tokenId);
      if (entry) this.scheduleEval(entry.asset);
    });
    this.twap.start();
    this.stream.start();
    this.journal.write("events", { type: "start", mode: this.cfg.mode, assets: this.cfg.assets });

    this.loopTimer = setInterval(() => this.tick(), 1000);
    this.statusTimer = setInterval(() => this.printStatus(), this.cfg.statusIntervalMs);
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.subsTimer) clearTimeout(this.subsTimer);
    for (const s of this.pairs.values()) if (s.evalTimer) clearTimeout(s.evalTimer);
    this.stream.stop();
    this.twap.stop();
    this.journal.write("events", { type: "stop", ...this.totals, ...this.risk.snapshot() });
    logInfo(
      `Stopped. Trades: ${this.totals.trades}, settled windows: ${this.totals.settledWindows}, ` +
        `settled PnL: ${this.totals.settledPnl.toFixed(2)} USD`,
    );
  }

  // ---------------------------------------------------------------- windows

  private tick(): void {
    const now = Date.now();
    const w = pairWindowAt(Math.floor(now / 1000));
    for (const asset of this.cfg.assets) {
      let state = this.pairs.get(asset);
      if (!state || state.window.end !== w.end) {
        if (state) this.closeWindow(state, now);
        state = this.newState(asset, w);
        this.pairs.set(asset, state);
      }
      if ((!state.m5 || !state.m15) && now - state.lastLoadAttempt > 5_000) {
        state.lastLoadAttempt = now;
        void this.loadMarkets(state);
      }
      this.captureBeats(state, now);
      this.scheduleEval(asset);
    }
    void this.runSettlements(now);
  }

  private newState(asset: string, window: PairWindow): PairState {
    return {
      asset,
      key: `${asset}-${window.end}`,
      window,
      m5: null,
      m15: null,
      lastLoadAttempt: 0,
      beat5m: null,
      beat15m: null,
      beatSource: { "5m": null, "15m": null },
      lastGammaBeatAttempt: 0,
      busy: false,
      evalTimer: null,
      lastEvalAt: 0,
      stats: { lastPairCost: null, minPairCost: null, opportunities: 0, trades: 0, lastBlock: null },
    };
  }

  private async loadMarkets(state: PairState): Promise<void> {
    try {
      const [m15, m5] = await Promise.all([
        state.m15 ? Promise.resolve(state.m15) : this.gamma.fetchMarket(state.asset, "15m", state.window.start15m),
        state.m5 ? Promise.resolve(state.m5) : this.gamma.fetchMarket(state.asset, "5m", state.window.start5m),
      ]);
      if (this.pairs.get(state.asset) !== state) return;
      if (!m15 || !m5) {
        logDebug(`${state.asset}: markets for window ending ${hhmm(state.window.end)} not listed yet`);
        return;
      }
      if (m15.endTime !== m5.endTime) {
        logWarn(`${state.asset}: 5m/15m end times differ (${m5.endTime} vs ${m15.endTime}); skipping window`);
        return;
      }
      await Promise.all([this.venue.prepareMarket(m15), this.venue.prepareMarket(m5)]);
      state.m15 = m15;
      state.m5 = m5;
      for (const m of [m15, m5]) {
        this.tokenIndex.set(m.upTokenId, { asset: state.asset, market: m });
        this.tokenIndex.set(m.downTokenId, { asset: state.asset, market: m });
      }
      logInfo(`${state.asset}: tracking ${m15.slug} + ${m5.slug} (settle ${hhmm(m5.endTime)} UTC)`);
      this.scheduleSubscriptionSync();
    } catch (err) {
      logWarn(`${state.asset}: failed to load markets: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Coalesce subscription changes (all assets roll over at the same moment). */
  private scheduleSubscriptionSync(): void {
    if (this.subsTimer) clearTimeout(this.subsTimer);
    this.subsTimer = setTimeout(() => {
      this.subsTimer = null;
      const tokens: string[] = [];
      for (const s of this.pairs.values()) {
        for (const m of [s.m15, s.m5]) if (m) tokens.push(m.upTokenId, m.downTokenId);
      }
      this.stream.setTokens(tokens);
    }, 500);
  }

  private closeWindow(state: PairState, now: number): void {
    if (state.evalTimer) clearTimeout(state.evalTimer);
    for (const m of [state.m15, state.m5]) {
      if (!m) continue;
      this.tokenIndex.delete(m.upTokenId);
      this.tokenIndex.delete(m.downTokenId);
    }
    if (state.m5 && state.m15) {
      this.settlements.push({
        state,
        dueAt: now + SETTLE_DELAY_MS,
        giveUpAt: now + SETTLE_GIVE_UP_MS,
      });
    }
    this.scheduleSubscriptionSync();
  }

  // ---------------------------------------------------------------- strikes

  private captureBeats(state: PairState, now: number): void {
    const sym = assetSymbol(state.asset);
    const nowSec = now / 1000;
    if (state.beat15m === null && nowSec >= state.window.start15m) {
      const v = this.twap.valueAt(sym, state.window.start15m);
      if (v !== null) this.setBeat(state, "15m", v, "chainlink-twap");
    }
    if (state.beat5m === null && nowSec >= state.window.start5m) {
      const v = this.twap.valueAt(sym, state.window.start5m);
      if (v !== null) this.setBeat(state, "5m", v, "chainlink-twap");
    }
    // If the bot started mid-window the TWAP tick at S was missed. Gamma
    // publishes priceToBeat a few minutes after a window opens, which is in
    // time for the 15m strike (needed only from S+600).
    if (state.beat15m === null && nowSec > state.window.start15m + 60 && now - state.lastGammaBeatAttempt > 30_000) {
      state.lastGammaBeatAttempt = now;
      void this.gammaStrike(state.asset, state.window.start15m).then((v) => {
        if (v !== null && state.beat15m === null) this.setBeat(state, "15m", v, "gamma");
      });
    }
  }

  private setBeat(state: PairState, horizon: "5m" | "15m", value: number, source: string): void {
    if (horizon === "5m") state.beat5m = value;
    else state.beat15m = value;
    state.beatSource[horizon] = source;
    logInfo(`${state.asset}: ${horizon} price to beat ${value.toFixed(6)} (${source}) for window ending ${hhmm(state.window.end)}`);
  }

  /** priceToBeat from Gamma for any market (5m or 15m) whose window starts at `startSec`. */
  private async gammaStrike(asset: string, startSec: number): Promise<number | null> {
    for (const horizon of ["5m", "15m"] as const) {
      try {
        const r = await this.gamma.fetchResolution(eventSlug(asset, horizon, startSec));
        if (r?.priceToBeat !== null && r?.priceToBeat !== undefined) return r.priceToBeat;
      } catch (err) {
        logDebug(`gammaStrike ${asset} ${horizon} ${startSec}: ${String(err)}`);
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- detection

  private scheduleEval(asset: string): void {
    const state = this.pairs.get(asset);
    if (!state || state.evalTimer) return;
    const wait = Math.max(0, MIN_EVAL_INTERVAL_MS - (Date.now() - state.lastEvalAt));
    state.evalTimer = setTimeout(() => {
      state.evalTimer = null;
      state.lastEvalAt = Date.now();
      this.evaluate(state);
    }, wait);
  }

  private quotes(market: MarketInfo): MarketQuotes | null {
    const up = this.stream.book(market.upTokenId);
    const down = this.stream.book(market.downTokenId);
    if (!up?.ready || !down?.ready) return null;
    const now = Date.now();
    if (now - up.updatedAt > this.cfg.maxBookAgeMs || now - down.updatedAt > this.cfg.maxBookAgeMs) return null;
    const tickSize = Math.max(up.tickSize ?? market.tickSize, down.tickSize ?? market.tickSize);
    return { market: { ...market, tickSize }, upAsks: up.asksAscending(), downAsks: down.asksAscending() };
  }

  private evaluate(state: PairState): void {
    const now = Date.now();
    const nowSec = now / 1000;
    const { m5, m15, beat5m, beat15m } = state;
    if (state.busy || !m5 || !m15 || beat5m === null || beat15m === null) return;
    if (nowSec < state.window.start5m || nowSec >= state.window.end) return;
    if (!this.stream.connected) return;

    const q5 = this.quotes(m5);
    const q15 = this.quotes(m15);
    if (!q5 || !q15) return;

    const pairCost = bestPairCost(q5, q15, beat5m, beat15m);
    state.stats.lastPairCost = pairCost;
    if (pairCost !== null && (state.stats.minPairCost === null || pairCost < state.stats.minPairCost)) {
      state.stats.minPairCost = pairCost;
    }
    if (pairCost === null || pairCost > 1 - this.cfg.minEdge) return;

    if (nowSec >= state.window.end - this.cfg.noTradeLastSeconds) {
      state.stats.lastBlock = "too close to settlement";
      return;
    }
    if (!m5.acceptingOrders || !m15.acceptingOrders) {
      state.stats.lastBlock = "market not accepting orders";
      return;
    }
    const budget = this.risk.budget(state.asset, state.key, now);
    if (!budget.ok) {
      state.stats.lastBlock = budget.reason;
      return;
    }
    state.stats.lastBlock = null;

    const opp = findOpportunity(
      q5,
      q15,
      beat5m,
      beat15m,
      {
        minEdge: this.cfg.minEdge,
        minProfitUsd: this.cfg.minProfitUsd,
        maxShares: this.cfg.maxSharesPerTrade,
        maxCostUsd: budget.usd,
        slippageTicks: this.cfg.slippageTicks,
        minOrderUsd: this.cfg.minOrderUsd,
      },
      now,
    );
    if (!opp) return;

    state.stats.opportunities++;
    state.busy = true;
    this.logOpportunity(opp);
    this.journal.write("opportunities", { window: state.key, beatSource: state.beatSource, ...opp });
    this.executor
      .execute(opp)
      .then((result) => this.onTradeResult(state, result))
      .catch((err) => {
        logError(`${state.asset}: execution failed:`, err);
        this.risk.halt(`unexpected execution error: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        state.busy = false;
      });
  }

  private logOpportunity(opp: Opportunity): void {
    const band = opp.bothWinBand ? ` | both legs win if final in [${opp.bothWinBand.from.toFixed(2)}, ${opp.bothWinBand.to.toFixed(2)})` : "";
    logInfo(
      `[OPPORTUNITY] ${opp.asset.toUpperCase()} settle ${hhmm(opp.endTime)}: ` +
        `BUY UP ${opp.up.horizon} @${opp.up.avgPrice.toFixed(4)} + BUY DOWN ${opp.down.horizon} @${opp.down.avgPrice.toFixed(4)} ` +
        `x${opp.shares} | cost ${opp.totalCost.toFixed(2)} (fees ${(opp.up.fee + opp.down.fee).toFixed(2)}) ` +
        `| locked profit ${opp.expectedProfit.toFixed(2)} USD (${(opp.edge * 100).toFixed(2)}%)${band}`,
    );
  }

  private onTradeResult(state: PairState, result: TradeResult): void {
    const now = Date.now();
    let ledger = this.ledgers.get(state.key);
    if (!ledger) {
      ledger = new WindowLedger();
      this.ledgers.set(state.key, ledger);
    }
    for (const f of [result.up, result.down, ...result.repairs]) ledger.apply(f);
    this.risk.recordTrade(state.asset, state.key, result, now);
    if (result.up.sharesFilled > 0 || result.down.sharesFilled > 0) {
      state.stats.trades++;
      this.totals.trades++;
    }

    const locked = state.beat5m !== null && state.beat15m !== null ? ledger.minPayout(state.beat5m, state.beat15m) - ledger.netCash : null;
    logInfo(
      `[TRADE ${result.status.toUpperCase()}] ${state.asset} ${result.mode}: UP ${result.up.sharesFilled.toFixed(2)} ` +
        `(${result.up.status}) / DOWN ${result.down.sharesFilled.toFixed(2)} (${result.down.status})` +
        `${result.repairs.length ? `, ${result.repairs.length} repair order(s)` : ""} in ${result.latencyMs}ms` +
        `${result.note ? ` — ${result.note}` : ""} | window worst-case PnL ${fmt(locked, 2)} USD`,
    );
    this.journal.write("trades", { window: state.key, ...result });

    if (this.venue.reconcile && ledger.positions.size > 0) {
      void this.reconcile(state, ledger.expectedShares());
    }
  }

  /**
   * Compare exchange balances with the ledger a few seconds after a trade.
   * Balances can lag settlement, so a mismatch must persist before halting.
   */
  private async reconcile(state: PairState, expected: Map<string, number>): Promise<void> {
    let problem: string | null = null;
    for (const delayMs of [5_000, 10_000, 20_000]) {
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        problem = await this.venue.reconcile!(expected);
      } catch (err) {
        logWarn(`Balance reconciliation failed: ${String(err)}`);
        return;
      }
      if (!problem) return;
      logWarn(`${state.asset}: balance check mismatch (${problem}); re-checking`);
    }
    this.journal.write("events", { type: "reconcile_mismatch", window: state.key, problem });
    this.risk.halt(`exchange balances differ from the bot's records: ${problem}`);
  }

  // ---------------------------------------------------------------- settlement

  private async runSettlements(now: number): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    try {
      for (const job of [...this.settlements]) {
        if (job.dueAt > now) continue;
        const done = await this.settle(job, now);
        if (done) this.settlements.splice(this.settlements.indexOf(job), 1);
        else job.dueAt = now + SETTLE_POLL_MS;
      }
    } finally {
      this.settling = false;
    }
  }

  private async settle(job: SettlementJob, now: number): Promise<boolean> {
    const { state } = job;
    // Looked up now: a trade still executing at rollover may have created it late.
    const ledger = this.ledgers.get(state.key);
    const m5 = state.m5!;
    const m15 = state.m15!;
    let r5;
    let r15;
    try {
      [r5, r15] = await Promise.all([this.gamma.fetchResolution(m5.slug), this.gamma.fetchResolution(m15.slug)]);
    } catch (err) {
      logDebug(`settle ${state.key}: ${String(err)}`);
      return false;
    }
    const resolved = Boolean(r5?.winner && r15?.winner);
    if (!resolved && now < job.giveUpAt) return false;

    const audit = {
      "5m": { ours: state.beat5m, gamma: r5?.priceToBeat ?? null },
      "15m": { ours: state.beat15m, gamma: r15?.priceToBeat ?? null },
    };
    for (const h of ["5m", "15m"] as const) {
      const { ours, gamma } = audit[h];
      if (ours !== null && gamma !== null && Math.abs(ours - gamma) > Math.max(1e-6, Math.abs(gamma) * 1e-9)) {
        logWarn(`${state.asset} ${h}: our price to beat ${ours} differs from Gamma's ${gamma}`);
        this.journal.write("events", { type: "beat_mismatch", window: state.key, horizon: h, ours, gamma });
      }
    }

    let pnl: number | null = null;
    let payout: number | null = null;
    if (ledger && !ledger.isEmpty) {
      if (resolved) {
        payout = ledger.payout({ "5m": r5!.winner!, "15m": r15!.winner! });
        pnl = payout - ledger.netCash;
        this.risk.recordSettlement(pnl, now);
        this.totals.settledPnl += pnl;
        logInfo(
          `[SETTLED] ${state.asset} ${hhmm(state.window.end)}: 5m ${r5!.winner}, 15m ${r15!.winner}; ` +
            `payout ${payout.toFixed(2)} - cost ${ledger.netCash.toFixed(2)} = PnL ${pnl.toFixed(2)} USD` +
            (this.cfg.mode === "live" ? " (redeem winning shares on Polymarket to collect)" : ""),
        );
      } else {
        logWarn(`${state.asset} ${hhmm(state.window.end)}: resolution not available; PnL unknown`);
      }
    }
    this.totals.settledWindows++;
    this.journal.write("windows", {
      window: state.key,
      asset: state.asset,
      end: state.window.end,
      slugs: { "5m": m5.slug, "15m": m15.slug },
      beats: audit,
      beatSource: state.beatSource,
      finalPrice: { "5m": r5?.finalPrice ?? null, "15m": r15?.finalPrice ?? null },
      winners: { "5m": r5?.winner ?? null, "15m": r15?.winner ?? null },
      minPairCost: state.stats.minPairCost,
      opportunities: state.stats.opportunities,
      trades: state.stats.trades,
      positions: ledger ? [...ledger.positions.values()] : [],
      netCash: ledger?.netCash ?? 0,
      payout,
      pnl,
    });
    this.ledgers.delete(state.key);
    this.risk.forgetWindow(state.key);
    return true;
  }

  // ---------------------------------------------------------------- status

  private printStatus(): void {
    const nowSec = Date.now() / 1000;
    const lines: string[] = [];
    for (const s of this.pairs.values()) {
      let phase: string;
      if (!s.m5 || !s.m15) phase = "loading markets";
      else if (nowSec < s.window.start5m) phase = `5m window opens in ${Math.ceil(s.window.start5m - nowSec)}s`;
      else if (s.beat5m === null || s.beat15m === null) phase = "waiting for strikes";
      else phase = `pair cost ${fmt(s.stats.lastPairCost)} (min ${fmt(s.stats.minPairCost)})`;
      const block = s.stats.lastBlock ? ` [${s.stats.lastBlock}]` : "";
      lines.push(
        `  ${s.asset.padEnd(5)} settle ${hhmm(s.window.end)} | strikes 5m ${fmtStrike(s.beat5m)} / 15m ${fmtStrike(s.beat15m)} | ` +
          `${phase} | opps ${s.stats.opportunities} trades ${s.stats.trades}${block}`,
      );
    }
    const r = this.risk.snapshot();
    const halted = this.risk.halted ? ` | HALTED: ${this.risk.halted}` : "";
    logInfo(
      `[STATUS] ${this.cfg.mode} | books ${this.stream.connected ? "on" : "OFF"} | chainlink ${this.twap.connected ? "on" : "OFF"} | ` +
        `trades today ${r.dailyTrades} | settled PnL today ${r.dailyPnl.toFixed(2)} USD${halted}\n${lines.join("\n")}`,
    );
  }
}
