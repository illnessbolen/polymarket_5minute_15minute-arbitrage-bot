/**
 * Polymarket taker fee model.
 *
 * fee = shares * rate * (p * (1 - p)) ^ exponent, paid in USDC on top of the
 * order notional (see `adjustBuyAmountForFees` in @polymarket/clob-client-v2
 * and https://docs.polymarket.com/trading/fees). Crypto up/down markets
 * currently publish { rate: 0.07, exponent: 1, takerOnly: true }, i.e. at most
 * 1.75 cents per share at p = 0.5. Makers pay nothing.
 */

import type { BookLevel, FeeSchedule } from "../types";

export const ZERO_FEE: FeeSchedule = { rate: 0, exponent: 1, takerOnly: true };

/** Taker fee for one share bought or sold at `price`. */
export function feePerShare(price: number, fee: FeeSchedule): number {
  if (fee.rate <= 0 || price <= 0 || price >= 1) return 0;
  return fee.rate * Math.pow(price * (1 - price), fee.exponent);
}

/** Fees are rounded to 5 decimals by the exchange; round up to stay conservative. */
export function roundFee(x: number): number {
  return Math.ceil(x * 1e5 - 1e-9) / 1e5;
}

export function takerFee(shares: number, price: number, fee: FeeSchedule): number {
  return roundFee(shares * feePerShare(price, fee));
}

/** Fee for buying through a sequence of book levels (each fill is charged at its own price). */
export function takerFeeForFills(fills: BookLevel[], fee: FeeSchedule): number {
  let total = 0;
  for (const f of fills) total += f.size * feePerShare(f.price, fee);
  return roundFee(total);
}

/**
 * Highest per-share fee for any fill price in [lo, hi].
 * p(1-p) peaks at 0.5, so the max is at 0.5 if it lies inside the range.
 */
export function maxFeePerShareInRange(lo: number, hi: number, fee: FeeSchedule): number {
  if (lo <= 0.5 && hi >= 0.5) return feePerShare(0.5, fee);
  return Math.max(feePerShare(lo, fee), feePerShare(hi, fee));
}
