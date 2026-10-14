/**
 * Cross-horizon arbitrage between a 5-minute and a 15-minute up/down market
 * that settle at the same instant on the same Chainlink price.
 *
 * Both markets pay UP if final >= strike ("price to beat"), else DOWN. With
 * strikes b5 and b15:
 *   - buy UP in the market with the LOWER strike and DOWN in the one with the
 *     HIGHER strike;
 *   - final < low strike  -> DOWN wins;  final >= high strike -> UP wins;
 *   - low <= final < high -> both win (payout 2 per share);
 *   - with equal strikes exactly one leg wins.
 * So one share of each leg pays at least 1. If both legs cost less than 1
 * (fees included), the difference is locked in profit.
 */

import type { BookLevel, FeeSchedule, Horizon, LegPlan, MarketInfo, Opportunity, Outcome } from "../types";
import { feePerShare, maxFeePerShareInRange, takerFeeForFills } from "./fees";
import { sweep } from "./orderbook";

const EPS = 1e-9;

export interface ArbParams {
  /** Minimum locked-in profit per share after fees (USDC). */
  minEdge: number;
  /** Minimum expected profit per trade (USDC). */
  minProfitUsd: number;
  /** Cap on shares per leg per trade. */
  maxShares: number;
  /** Cap on total outlay per trade (both legs + fees, USDC). */
  maxCostUsd: number;
  /** Extra ticks of price tolerance added to each leg's limit price. */
  slippageTicks: number;
  /** Exchange minimum notional per order (USDC). */
  minOrderUsd: number;
}

export interface MarketQuotes {
  market: MarketInfo;
  /** UP-token asks, cheapest first. */
  upAsks: BookLevel[];
  /** DOWN-token asks, cheapest first. */
  downAsks: BookLevel[];
}

export interface Direction {
  up: Horizon;
  down: Horizon;
}

/** Which UP/DOWN combinations are a full hedge for the given strikes. */
export function hedgedDirections(beat5m: number, beat15m: number): Direction[] {
  if (Math.abs(beat5m - beat15m) < EPS) {
    return [
      { up: "5m", down: "15m" },
      { up: "15m", down: "5m" },
    ];
  }
  return beat5m < beat15m ? [{ up: "5m", down: "15m" }] : [{ up: "15m", down: "5m" }];
}

/**
 * Largest number of share pairs whose marginal cost (both asks + both fees)
 * still leaves at least `minEdge` per pair, walking both ask ladders together.
 */
export function maxProfitablePairs(
  upAsks: BookLevel[],
  downAsks: BookLevel[],
  upFee: FeeSchedule,
  downFee: FeeSchedule,
  params: Pick<ArbParams, "minEdge" | "maxShares" | "maxCostUsd">,
): number {
  let i = 0;
  let j = 0;
  let upLeft = upAsks[0]?.size ?? 0;
  let downLeft = downAsks[0]?.size ?? 0;
  let shares = 0;
  let outlay = 0;

  while (i < upAsks.length && j < downAsks.length) {
    const pu = upAsks[i].price;
    const pd = downAsks[j].price;
    const marginal = pu + pd + feePerShare(pu, upFee) + feePerShare(pd, downFee);
    if (1 - marginal < params.minEdge - EPS) break;

    let q = Math.min(upLeft, downLeft, params.maxShares - shares);
    q = Math.min(q, (params.maxCostUsd - outlay) / marginal);
    if (q <= EPS) break;

    shares += q;
    outlay += q * marginal;
    upLeft -= q;
    downLeft -= q;
    if (upLeft <= EPS) upLeft = upAsks[++i]?.size ?? 0;
    if (downLeft <= EPS) downLeft = downAsks[++j]?.size ?? 0;
  }
  return shares;
}

/** Number of decimals in a tick size such as 0.01, 0.005 or 0.001. */
function tickDecimals(tick: number): number {
  const s = tick.toFixed(10).replace(/0+$/, "");
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Share-count granularity that keeps `shares * price` at 2 decimals, which
 * the CLOB requires for the USDC side of FOK orders.
 */
export function shareGranularity(tick: number): number {
  return Math.pow(10, Math.max(0, tickDecimals(tick) - 2));
}

function roundToTick(price: number, tick: number): number {
  const d = tickDecimals(tick);
  return Number((Math.round(price / tick) * tick).toFixed(d));
}

function planLeg(
  market: MarketInfo,
  outcome: Outcome,
  asks: BookLevel[],
  shares: number,
  slippageTicks: number,
): LegPlan | null {
  const fill = sweep(asks, shares, () => true);
  if (fill.shares + EPS < shares) return null;
  const tick = market.tickSize;
  const limitPrice = Math.min(roundToTick(fill.worstPrice + slippageTicks * tick, tick), roundToTick(1 - tick, tick));
  return {
    horizon: market.horizon,
    outcome,
    tokenId: outcome === "UP" ? market.upTokenId : market.downTokenId,
    shares,
    avgPrice: fill.avgPrice,
    limitPrice,
    cost: fill.cost,
    fee: takerFeeForFills(fill.fills, market.fee),
    tickSize: tick,
    negRisk: market.negRisk,
  };
}

function worstCaseLegCost(leg: LegPlan, fee: FeeSchedule): number {
  return leg.shares * (leg.limitPrice + maxFeePerShareInRange(leg.avgPrice, leg.limitPrice, fee));
}

function buildOpportunity(
  asset: string,
  upSide: MarketQuotes,
  downSide: MarketQuotes,
  beat5m: number,
  beat15m: number,
  params: ArbParams,
  now: number,
): Opportunity | null {
  const upMarket = upSide.market;
  const downMarket = downSide.market;

  const raw = maxProfitablePairs(upSide.upAsks, downSide.downAsks, upMarket.fee, downMarket.fee, params);
  const step = Math.max(shareGranularity(upMarket.tickSize), shareGranularity(downMarket.tickSize));
  const shares = Math.floor(raw / step + EPS) * step;
  if (shares <= 0) return null;
  if (shares < Math.max(upMarket.minOrderSize, downMarket.minOrderSize)) return null;

  // Prefer the requested slippage tolerance, but never let the worst case
  // (every fill at the limit price) turn the hedge into a loss.
  for (let slip = Math.max(0, params.slippageTicks); slip >= 0; slip--) {
    const up = planLeg(upMarket, "UP", upSide.upAsks, shares, slip);
    const down = planLeg(downMarket, "DOWN", downSide.downAsks, shares, slip);
    if (!up || !down) return null;

    if (up.limitPrice * shares < params.minOrderUsd || down.limitPrice * shares < params.minOrderUsd) return null;

    const worstCaseCost = worstCaseLegCost(up, upMarket.fee) + worstCaseLegCost(down, downMarket.fee);
    if (worstCaseCost > shares + EPS) continue;

    const totalCost = up.cost + up.fee + down.cost + down.fee;
    const expectedProfit = shares - totalCost;
    const edge = expectedProfit / shares;
    if (edge < params.minEdge - EPS || expectedProfit < params.minProfitUsd - EPS) return null;

    const upStrike = upMarket.horizon === "5m" ? beat5m : beat15m;
    const downStrike = downMarket.horizon === "5m" ? beat5m : beat15m;

    return {
      asset,
      endTime: upMarket.endTime,
      beat5m,
      beat15m,
      up,
      down,
      shares,
      totalCost,
      worstCaseCost,
      guaranteedPayout: shares,
      expectedProfit,
      edge,
      bothWinBand: downStrike - upStrike > EPS ? { from: upStrike, to: downStrike } : null,
      detectedAt: now,
    };
  }
  return null;
}

/**
 * Best fully-hedged opportunity between a 5m and a 15m market that end at the
 * same time, or null if none clears the thresholds.
 */
export function findOpportunity(
  q5m: MarketQuotes,
  q15m: MarketQuotes,
  beat5m: number,
  beat15m: number,
  params: ArbParams,
  now = Date.now(),
): Opportunity | null {
  if (q5m.market.endTime !== q15m.market.endTime) return null;
  if (!Number.isFinite(beat5m) || !Number.isFinite(beat15m)) return null;

  let best: Opportunity | null = null;
  for (const dir of hedgedDirections(beat5m, beat15m)) {
    const upSide = dir.up === "5m" ? q5m : q15m;
    const downSide = dir.down === "5m" ? q5m : q15m;
    const opp = buildOpportunity(q5m.market.asset, upSide, downSide, beat5m, beat15m, params, now);
    if (opp && (!best || opp.expectedProfit > best.expectedProfit)) best = opp;
  }
  return best;
}

/** Cheapest pair cost (best asks + fees) for the hedged direction(s); for display. */
export function bestPairCost(q5m: MarketQuotes, q15m: MarketQuotes, beat5m: number, beat15m: number): number | null {
  let best: number | null = null;
  for (const dir of hedgedDirections(beat5m, beat15m)) {
    const upSide = dir.up === "5m" ? q5m : q15m;
    const downSide = dir.down === "5m" ? q5m : q15m;
    const pu = upSide.upAsks[0]?.price;
    const pd = downSide.downAsks[0]?.price;
    if (pu === undefined || pd === undefined) continue;
    const cost = pu + pd + feePerShare(pu, upSide.market.fee) + feePerShare(pd, downSide.market.fee);
    if (best === null || cost < best) best = cost;
  }
  return best;
}
