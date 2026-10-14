/**
 * Risk limits and kill switch.
 */

import type { Config } from "../config";
import type { TradeResult } from "../types";
import { logError, logWarn } from "../utils/logger";

interface WindowUsage {
  usd: number;
  trades: number;
}

export class RiskManager {
  private day = "";
  private dailyTrades = 0;
  private dailyPnl = 0;
  private consecutiveFailures = 0;
  private readonly windows = new Map<string, WindowUsage>();
  private readonly cooldownUntil = new Map<string, number>();
  private haltReason: string | null = null;

  constructor(private readonly cfg: Config) {}

  get halted(): string | null {
    return this.haltReason;
  }

  halt(reason: string): void {
    if (this.haltReason) return;
    this.haltReason = reason;
    logError(`TRADING HALTED: ${reason}. Monitoring continues; restart the bot after reviewing.`);
  }

  private rollDay(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dailyTrades = 0;
      this.dailyPnl = 0;
    }
  }

  /** Remaining USD budget for a new trade in this window, or a reason it is blocked. */
  budget(asset: string, windowKey: string, now: number): { ok: true; usd: number } | { ok: false; reason: string } {
    this.rollDay(now);
    if (this.haltReason) return { ok: false, reason: "halted" };
    if ((this.cooldownUntil.get(asset) ?? 0) > now) return { ok: false, reason: "cooldown" };
    if (this.dailyTrades >= this.cfg.maxDailyTrades) return { ok: false, reason: "daily trade limit" };
    if (this.dailyPnl <= -this.cfg.maxDailyLossUsd) return { ok: false, reason: "daily loss limit" };
    const w = this.windows.get(windowKey) ?? { usd: 0, trades: 0 };
    if (w.trades >= this.cfg.maxTradesPerWindow) return { ok: false, reason: "window trade limit" };
    const usd = Math.min(this.cfg.maxUsdPerTrade, this.cfg.maxUsdPerWindow - w.usd);
    if (usd < this.cfg.minOrderUsd * 2) return { ok: false, reason: "window budget used" };
    return { ok: true, usd };
  }

  recordTrade(asset: string, windowKey: string, result: TradeResult, now: number): void {
    this.rollDay(now);
    this.cooldownUntil.set(asset, now + this.cfg.tradeCooldownMs);
    const spent = [result.up, result.down, ...result.repairs]
      .filter((f) => f.side === "BUY")
      .reduce((s, f) => s + f.cost + f.fee, 0);
    if (spent > 0) {
      const w = this.windows.get(windowKey) ?? { usd: 0, trades: 0 };
      w.usd += spent;
      w.trades += 1;
      this.windows.set(windowKey, w);
      this.dailyTrades += 1;
    }

    if (result.status === "filled" || result.status === "rejected") {
      if (result.status === "filled") this.consecutiveFailures = 0;
      return;
    }
    if (result.status === "hedged") {
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures += 1;
    logWarn(`Trade ended as "${result.status}" (${this.consecutiveFailures} in a row)`);
    if (result.status === "unhedged") this.halt("a position could not be hedged or unwound");
    else if (this.consecutiveFailures >= this.cfg.maxConsecutiveFailures) {
      this.halt(`${this.consecutiveFailures} consecutive failed or repaired trades`);
    }
  }

  recordSettlement(pnl: number, now: number): void {
    this.rollDay(now);
    this.dailyPnl += pnl;
    if (this.dailyPnl <= -this.cfg.maxDailyLossUsd) this.halt(`daily loss limit reached (${this.dailyPnl.toFixed(2)} USD)`);
  }

  forgetWindow(windowKey: string): void {
    this.windows.delete(windowKey);
  }

  snapshot(): { dailyTrades: number; dailyPnl: number } {
    return { dailyTrades: this.dailyTrades, dailyPnl: this.dailyPnl };
  }
}
