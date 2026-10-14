/**
 * Time-window arithmetic for recurring up/down markets.
 *
 * A 15m window [S, S+900) shares its end with the 5m window [S+600, S+900).
 * During those last five minutes both markets trade on the same settlement
 * price, which is when the cross-horizon hedge exists.
 */

import type { Horizon } from "../types";

export const HORIZON_SECONDS: Record<Horizon, number> = { "5m": 300, "15m": 900 };

export function windowStart(horizon: Horizon, unixSec: number): number {
  const len = HORIZON_SECONDS[horizon];
  return Math.floor(unixSec / len) * len;
}

export function eventSlug(asset: string, horizon: Horizon, startSec: number): string {
  return `${asset}-updown-${horizon}-${startSec}`;
}

export interface PairWindow {
  /** Start of the 15m window. */
  start15m: number;
  /** Start of the last 5m window inside it. */
  start5m: number;
  /** Shared settlement time. */
  end: number;
}

/** The 15m window containing `unixSec` and its aligned final 5m window. */
export function pairWindowAt(unixSec: number): PairWindow {
  const start15m = windowStart("15m", unixSec);
  const end = start15m + HORIZON_SECONDS["15m"];
  return { start15m, start5m: end - HORIZON_SECONDS["5m"], end };
}
