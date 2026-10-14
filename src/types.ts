/**
 * Shared types for the 5m/15m up-or-down arbitrage bot.
 */

export type Horizon = "5m" | "15m";
export type Outcome = "UP" | "DOWN";

/** Taker fee parameters published per market in Gamma `feeSchedule`. */
export interface FeeSchedule {
  rate: number;
  exponent: number;
  takerOnly: boolean;
}

/** Static description of one up/down market, built from the Gamma event. */
export interface MarketInfo {
  asset: string;
  horizon: Horizon;
  slug: string;
  eventId: string;
  conditionId: string;
  title: string;
  /** Window start, unix seconds (the "price to beat" is fixed at this instant). */
  startTime: number;
  /** Window end, unix seconds (settlement instant). */
  endTime: number;
  upTokenId: string;
  downTokenId: string;
  tickSize: number;
  minOrderSize: number;
  fee: FeeSchedule;
  negRisk: boolean;
  acceptingOrders: boolean;
  closed: boolean;
}

export interface BookLevel {
  price: number;
  size: number;
}

/** One leg of a planned or executed trade. */
export interface LegPlan {
  horizon: Horizon;
  outcome: Outcome;
  tokenId: string;
  shares: number;
  /** Volume-weighted price expected from the current book. */
  avgPrice: number;
  /** Worst book level touched; the order's limit price. */
  limitPrice: number;
  /** Expected USDC spent on shares (excluding fees). */
  cost: number;
  /** Expected taker fee in USDC. */
  fee: number;
  tickSize: number;
  negRisk: boolean;
}

/** A fully-sized arbitrage opportunity, ready to execute. */
export interface Opportunity {
  asset: string;
  endTime: number;
  beat5m: number;
  beat15m: number;
  up: LegPlan;
  down: LegPlan;
  shares: number;
  /** Expected total outlay: both legs' cost + fees. */
  totalCost: number;
  /** Upper bound of outlay if every fill hits the limit price. */
  worstCaseCost: number;
  /** Guaranteed payout: exactly one leg (or both) pays 1 per share. */
  guaranteedPayout: number;
  /** guaranteedPayout - totalCost. */
  expectedProfit: number;
  /** Profit per share. */
  edge: number;
  /**
   * Settlement-price band in which both legs win (payout 2 per share).
   * null when the two strikes are equal.
   */
  bothWinBand: { from: number; to: number } | null;
  detectedAt: number;
}

export interface LegFill {
  side: "BUY" | "SELL";
  tokenId: string;
  outcome: Outcome;
  horizon: Horizon;
  sharesFilled: number;
  /** USDC paid (BUY) or received (SELL), excluding fees. */
  cost: number;
  fee: number;
  orderId?: string;
  status: string;
  error?: string;
}

export type TradeStatus = "filled" | "rejected" | "hedged" | "unwound" | "unhedged" | "error";

export interface TradeResult {
  id: string;
  mode: "paper" | "live";
  opportunity: Opportunity;
  status: TradeStatus;
  up: LegFill;
  down: LegFill;
  /** Extra fills made while repairing a one-sided fill. */
  repairs: LegFill[];
  latencyMs: number;
  note?: string;
}
