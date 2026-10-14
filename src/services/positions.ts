/**
 * Per-window position ledger: shares held per outcome token and net cash
 * spent, used to compute PnL once both markets settle.
 */

import type { LegFill, Outcome } from "../types";

export interface TokenPosition {
  tokenId: string;
  outcome: Outcome;
  horizon: "5m" | "15m";
  shares: number;
}

export class WindowLedger {
  readonly positions = new Map<string, TokenPosition>();
  /** USDC spent minus USDC received, fees included. */
  netCash = 0;
  fees = 0;

  apply(fill: LegFill): void {
    if (fill.sharesFilled <= 0) return;
    const pos = this.positions.get(fill.tokenId) ?? {
      tokenId: fill.tokenId,
      outcome: fill.outcome,
      horizon: fill.horizon,
      shares: 0,
    };
    if (fill.side === "BUY") {
      pos.shares += fill.sharesFilled;
      this.netCash += fill.cost + fill.fee;
    } else {
      pos.shares -= fill.sharesFilled;
      this.netCash -= fill.cost - fill.fee;
    }
    this.fees += fill.fee;
    this.positions.set(fill.tokenId, pos);
  }

  get isEmpty(): boolean {
    return [...this.positions.values()].every((p) => Math.abs(p.shares) < 1e-9) && Math.abs(this.netCash) < 1e-9;
  }

  /** Payout given each market's winner (keyed by horizon). */
  payout(winners: Record<"5m" | "15m", Outcome>): number {
    let total = 0;
    for (const p of this.positions.values()) if (winners[p.horizon] === p.outcome) total += p.shares;
    return total;
  }

  /** Worst-case payout over every possible settlement price (for risk display). */
  minPayout(beat5m: number, beat15m: number): number {
    const strikes = [...new Set([beat5m, beat15m])].sort((a, b) => a - b);
    const probes = [strikes[0] - 1, ...strikes, ...strikes.slice(0, -1).map((s, i) => (s + strikes[i + 1]) / 2), strikes[strikes.length - 1] + 1];
    let min = Infinity;
    for (const f of probes) {
      const winners = {
        "5m": (f >= beat5m ? "UP" : "DOWN") as Outcome,
        "15m": (f >= beat15m ? "UP" : "DOWN") as Outcome,
      };
      min = Math.min(min, this.payout(winners));
    }
    return min === Infinity ? 0 : min;
  }

  expectedShares(): Map<string, number> {
    return new Map([...this.positions.values()].map((p) => [p.tokenId, p.shares]));
  }
}
