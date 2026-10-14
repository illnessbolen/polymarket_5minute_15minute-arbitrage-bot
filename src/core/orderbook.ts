/**
 * Local L2 order book for one outcome token, maintained from the CLOB
 * market WebSocket (`book` snapshots + `price_change` level updates).
 *
 * Note: the CLOB returns asks sorted from worst (0.99) to best and bids from
 * worst (0.01) to best, so "first element" is never the best price. This class
 * stores levels by price and sorts on demand.
 */

import type { BookLevel } from "../types";

const SCALE = 1e6;
const key = (price: number): number => Math.round(price * SCALE);
const EPS = 1e-9;

export interface Fill {
  /** Shares actually obtainable (may be less than requested). */
  shares: number;
  /** USDC spent (excluding fees). */
  cost: number;
  avgPrice: number;
  worstPrice: number;
  /** Per-level fills, best first. */
  fills: BookLevel[];
}

export class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  /** Local time (ms) of the last applied update. */
  updatedAt = 0;
  /** Exchange timestamp (ms) of the last applied update. */
  exchangeTs = 0;
  hash = "";
  tickSize: number | null = null;
  /** True once a full snapshot has been applied since the last reset. */
  ready = false;

  constructor(readonly tokenId: string) {}

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.ready = false;
  }

  applySnapshot(bids: BookLevel[], asks: BookLevel[], exchangeTs: number, hash = ""): void {
    this.bids.clear();
    this.asks.clear();
    for (const l of bids) if (l.size > 0) this.bids.set(key(l.price), l.size);
    for (const l of asks) if (l.size > 0) this.asks.set(key(l.price), l.size);
    this.exchangeTs = exchangeTs;
    this.hash = hash;
    this.updatedAt = Date.now();
    this.ready = true;
  }

  /**
   * Set the aggregate size resting at one level (size 0 removes the level).
   * `side` follows the CLOB convention: BUY = bid, SELL = ask.
   */
  applyLevel(side: "BUY" | "SELL", price: number, size: number, exchangeTs: number): void {
    const book = side === "BUY" ? this.bids : this.asks;
    if (size <= 0) book.delete(key(price));
    else book.set(key(price), size);
    if (exchangeTs > this.exchangeTs) this.exchangeTs = exchangeTs;
    this.updatedAt = Date.now();
  }

  /** Drop bids priced above `price` (consumed by a trade we saw no level update for). */
  trimBidsAbove(price: number): void {
    const limit = key(price);
    for (const k of [...this.bids.keys()]) if (k > limit) this.bids.delete(k);
  }

  /** Drop asks priced below `price`. */
  trimAsksBelow(price: number): void {
    const limit = key(price);
    for (const k of [...this.asks.keys()]) if (k < limit) this.asks.delete(k);
  }

  bestAsk(): number | null {
    let best: number | null = null;
    for (const k of this.asks.keys()) if (best === null || k < best) best = k;
    return best === null ? null : best / SCALE;
  }

  bestBid(): number | null {
    let best: number | null = null;
    for (const k of this.bids.keys()) if (best === null || k > best) best = k;
    return best === null ? null : best / SCALE;
  }

  /** Asks, cheapest first. */
  asksAscending(): BookLevel[] {
    return [...this.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, size]) => ({ price: k / SCALE, size }));
  }

  /** Bids, highest first. */
  bidsDescending(): BookLevel[] {
    return [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([k, size]) => ({ price: k / SCALE, size }));
  }

  /** Simulate buying `shares` by sweeping asks no worse than `limitPrice`. */
  quoteBuy(shares: number, limitPrice = 1): Fill {
    return sweep(this.asksAscending(), shares, (p) => p <= limitPrice + EPS);
  }

  /** Simulate selling `shares` by sweeping bids no worse than `limitPrice`. */
  quoteSell(shares: number, limitPrice = 0): Fill {
    return sweep(this.bidsDescending(), shares, (p) => p >= limitPrice - EPS);
  }
}

/** Walk sorted levels (best first) until `shares` are filled or `accept` rejects a price. */
export function sweep(levels: BookLevel[], shares: number, accept: (price: number) => boolean): Fill {
  const fills: BookLevel[] = [];
  let remaining = shares;
  let cost = 0;
  let worst = 0;
  for (const level of levels) {
    if (remaining <= EPS) break;
    if (!accept(level.price)) break;
    const take = Math.min(remaining, level.size);
    fills.push({ price: level.price, size: take });
    cost += take * level.price;
    remaining -= take;
    worst = level.price;
  }
  const filled = shares - Math.max(remaining, 0);
  return {
    shares: filled,
    cost,
    avgPrice: filled > 0 ? cost / filled : 0,
    worstPrice: worst,
    fills,
  };
}
