/**
 * Executes an opportunity: both legs go out together as fill-or-kill buys.
 * If only one leg fills (the book moved during the exchange's taker delay),
 * the executor tries to complete the hedge at a bounded loss and otherwise
 * unwinds (sells) the excess shares, so the bot does not keep a directional bet.
 */

import { randomUUID } from "crypto";
import type { LegFill, MarketInfo, Opportunity, TradeResult, TradeStatus } from "../types";
import type { OrderBook } from "../core/orderbook";
import { feePerShare } from "../core/fees";
import type { OrderRequest, Venue } from "./venue";
import { logInfo, logWarn } from "../utils/logger";

const EPS = 1e-6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RepairConfig {
  /** Max loss per share accepted to complete a broken hedge (pair cost may reach 1 + this). */
  hedgeMaxLossPerShare: number;
  hedgeAttempts: number;
  hedgeRetryDelayMs: number;
  /** What to do with excess shares if the hedge cannot be completed. */
  unhedgedAction: "sell" | "hold";
  /** Ticks below the best bid accepted when unwinding. */
  unwindSlippageTicks: number;
}

export class TradeExecutor {
  constructor(
    private readonly venue: Venue,
    private readonly books: (tokenId: string) => OrderBook | undefined,
    private readonly markets: (tokenId: string) => MarketInfo | undefined,
    private readonly cfg: RepairConfig,
  ) {}

  async execute(opp: Opportunity): Promise<TradeResult> {
    const started = Date.now();
    const upReq = this.request(opp.up.tokenId, opp.up.shares, opp.up.limitPrice);
    const downReq = this.request(opp.down.tokenId, opp.down.shares, opp.down.limitPrice);
    if (!upReq || !downReq) throw new Error("market metadata missing for opportunity legs");

    const [up, down] = await this.venue.buyPair(upReq, downReq);
    const result: TradeResult = {
      id: randomUUID(),
      mode: this.venue.mode,
      opportunity: opp,
      status: "filled",
      up,
      down,
      repairs: [],
      latencyMs: 0,
    };

    // Buys can return a few surplus shares on price improvement; only a leg
    // short of the planned size needs repair.
    const target = opp.shares;
    const short = (f: LegFill) => f.sharesFilled < target - 0.01;
    if (up.sharesFilled < EPS && down.sharesFilled < EPS) {
      result.status = up.status === "error" || down.status === "error" ? "error" : "rejected";
      result.note = up.error || down.error;
    } else if (!short(up) && !short(down)) {
      result.status = "filled";
    } else {
      const [filled, other, otherReq] = up.sharesFilled >= down.sharesFilled ? [up, down, downReq] : [down, up, upReq];
      const missing = Math.min(filled.sharesFilled, target) - other.sharesFilled;
      result.status = await this.repair(result, filled, otherReq, missing);
    }
    result.latencyMs = Date.now() - started;
    return result;
  }

  private request(tokenId: string, shares: number, limitPrice: number): OrderRequest | null {
    const m = this.markets(tokenId);
    if (!m) return null;
    const outcome = tokenId === m.upTokenId ? "UP" : "DOWN";
    return {
      tokenId,
      outcome,
      horizon: m.horizon,
      shares,
      limitPrice,
      tickSize: this.books(tokenId)?.tickSize ?? m.tickSize,
      negRisk: m.negRisk,
      fee: m.fee,
    };
  }

  /**
   * One leg filled more than the other. First try to buy the missing shares
   * while the completed pair still costs at most 1 + hedgeMaxLossPerShare;
   * failing that, sell (or keep) the excess.
   */
  private async repair(result: TradeResult, filled: LegFill, missingReq: OrderRequest, missing: number): Promise<TradeStatus> {
    const filledAvg = (filled.cost + filled.fee) / filled.sharesFilled;
    logWarn(
      `One-sided fill: ${filled.outcome} ${filled.horizon} filled ${filled.sharesFilled.toFixed(2)}, ` +
        `${missingReq.outcome} ${missingReq.horizon} short by ${missing.toFixed(2)} shares; repairing`,
    );

    const minSize = this.markets(missingReq.tokenId)?.minOrderSize ?? 5;
    if (missing < minSize) {
      result.note = `residual imbalance of ${missing.toFixed(2)} shares (below the ${minSize}-share order minimum)`;
      logWarn(`Keeping ${result.note}`);
      return "filled";
    }

    const maxPrice = 1 + this.cfg.hedgeMaxLossPerShare - filledAvg;
    for (let attempt = 1; attempt <= this.cfg.hedgeAttempts && missing > 0.01; attempt++) {
      const book = this.books(missingReq.tokenId);
      const quote = book?.quoteBuy(missing);
      const shares = this.roundShares(missing);
      if (quote && missing >= minSize && quote.shares + EPS >= missing) {
        const worst = quote.worstPrice;
        if (worst + feePerShare(worst, missingReq.fee) <= maxPrice + EPS) {
          const fill = await this.venue.buy({ ...missingReq, shares, limitPrice: worst }, "FOK");
          result.repairs.push(fill);
          missing -= fill.sharesFilled;
          if (missing <= 0.01) {
            logInfo(`Hedge completed on attempt ${attempt}`);
            return "hedged";
          }
        }
      }
      await sleep(this.cfg.hedgeRetryDelayMs);
    }

    if (this.cfg.unhedgedAction === "hold") {
      logWarn(`Hedge not completed; holding ${missing.toFixed(2)} unhedged ${filled.outcome} ${filled.horizon} shares`);
      return "unhedged";
    }

    const excessReq = this.request(filled.tokenId, 0, 0);
    if (!excessReq) return "unhedged";
    let excess = missing;
    for (let attempt = 1; attempt <= 3 && excess > 0.01; attempt++) {
      const bid = this.books(filled.tokenId)?.bestBid();
      if (bid) {
        const limit = Math.max(excessReq.tickSize, bid - this.cfg.unwindSlippageTicks * excessReq.tickSize);
        const shares = this.roundShares(excess, true);
        if (shares >= minSize) {
          const fill = await this.venue.sell({ ...excessReq, shares, limitPrice: Number(limit.toFixed(6)) }, "FAK");
          result.repairs.push(fill);
          excess -= fill.sharesFilled;
        }
      }
      if (excess > 0.01) await sleep(1_000);
    }
    if (excess <= 0.01) {
      logWarn("Excess shares sold; trade unwound");
      return "unwound";
    }
    logWarn(`Could not unwind ${excess.toFixed(2)} ${filled.outcome} ${filled.horizon} shares; position left open`);
    return "unhedged";
  }

  /** Share counts are sent with 2 decimals; sells must not exceed what we hold. */
  private roundShares(shares: number, down = false): number {
    const r = down ? Math.floor(shares * 100 + EPS) / 100 : Math.ceil(shares * 100 - EPS) / 100;
    return Math.max(0, r);
  }
}
