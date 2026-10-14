/**
 * Order-routing abstraction shared by paper and live trading.
 */

import type { FeeSchedule, Horizon, LegFill, MarketInfo, Outcome } from "../types";

export interface OrderRequest {
  tokenId: string;
  outcome: Outcome;
  horizon: Horizon;
  shares: number;
  /** Worst acceptable price (max for buys, min for sells). */
  limitPrice: number;
  tickSize: number;
  negRisk: boolean;
  fee: FeeSchedule;
}

/**
 * FOK: fill everything immediately or nothing.
 * FAK: fill what is available immediately, cancel the rest.
 */
export type TimeInForce = "FOK" | "FAK";

export interface Venue {
  readonly mode: "paper" | "live";
  init(): Promise<void>;
  /** Warm caches for a market before it becomes tradable. */
  prepareMarket(market: MarketInfo): Promise<void>;
  /** Submit both legs together as FOK buys. */
  buyPair(up: OrderRequest, down: OrderRequest): Promise<[LegFill, LegFill]>;
  buy(req: OrderRequest, tif: TimeInForce): Promise<LegFill>;
  sell(req: OrderRequest, tif: TimeInForce): Promise<LegFill>;
  /** Optional post-trade check of on-exchange balances; returns a problem description or null. */
  reconcile?(expected: Map<string, number>): Promise<string | null>;
}

export function emptyFill(req: OrderRequest, side: "BUY" | "SELL", status: string, error?: string): LegFill {
  return {
    side,
    tokenId: req.tokenId,
    outcome: req.outcome,
    horizon: req.horizon,
    sharesFilled: 0,
    cost: 0,
    fee: 0,
    status,
    error,
  };
}
