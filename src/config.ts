/**
 * Configuration from environment variables (see .env.example).
 */

import type { FeeSchedule } from "./types";

export type TradingMode = "paper" | "live";

export interface Config {
  mode: TradingMode;
  /** Assets to trade, e.g. ["btc", "eth"]. */
  assets: string[];

  // Opportunity thresholds
  minEdge: number;
  minProfitUsd: number;
  maxSharesPerTrade: number;
  maxUsdPerTrade: number;
  slippageTicks: number;
  minOrderUsd: number;

  // Risk limits
  maxUsdPerWindow: number;
  maxTradesPerWindow: number;
  maxDailyTrades: number;
  maxDailyLossUsd: number;
  maxConsecutiveFailures: number;
  tradeCooldownMs: number;
  /** Stop opening trades this many seconds before settlement. */
  noTradeLastSeconds: number;
  /** Ignore books not updated by the feed for this long. */
  maxBookAgeMs: number;

  // Leg repair
  hedgeMaxLossPerShare: number;
  hedgeAttempts: number;
  hedgeRetryDelayMs: number;
  unhedgedAction: "sell" | "hold";
  unwindSlippageTicks: number;

  // Paper simulation
  paperLatencyMs: number;

  /** Fee schedule assumed when a market does not publish one. */
  defaultFee: FeeSchedule;

  // Output
  logDir: string;
  statusIntervalMs: number;

  // Wallet / API (live mode)
  privateKey: string;
  signatureType: number;
  funderAddress: string;
  rpcUrl: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function parseSignatureType(raw: string): number {
  const v = raw.toLowerCase();
  if (v === "" || v === "0" || v === "eoa" || v === "main") return 0;
  if (v === "1" || v === "proxy" || v === "poly_proxy" || v === "email" || v === "magic") return 1;
  if (v === "2" || v === "safe" || v === "gnosis" || v === "browser") return 2;
  if (v === "3" || v === "1271") return 3;
  throw new Error(`POLY_SIGNATURE_TYPE must be 0 (EOA), 1 (Polymarket proxy) or 2 (Gnosis Safe), got "${raw}"`);
}

export function loadConfig(): Config {
  const mode = str("TRADING_MODE", "paper").toLowerCase();
  if (mode !== "paper" && mode !== "live") throw new Error(`TRADING_MODE must be "paper" or "live", got "${mode}"`);

  const unhedgedAction = str("UNHEDGED_ACTION", "sell").toLowerCase();
  if (unhedgedAction !== "sell" && unhedgedAction !== "hold") {
    throw new Error(`UNHEDGED_ACTION must be "sell" or "hold", got "${unhedgedAction}"`);
  }

  const assets = str("ASSETS", "btc,eth,sol,xrp")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  if (assets.length === 0) throw new Error("ASSETS must list at least one asset");

  const cfg: Config = {
    mode,
    assets,
    minEdge: num("MIN_EDGE", 0.01),
    minProfitUsd: num("MIN_PROFIT_USD", 0.05),
    maxSharesPerTrade: num("MAX_SHARES_PER_TRADE", 200),
    maxUsdPerTrade: num("MAX_USD_PER_TRADE", 50),
    slippageTicks: num("SLIPPAGE_TICKS", 0),
    minOrderUsd: num("MIN_ORDER_USD", 1),
    maxUsdPerWindow: num("MAX_USD_PER_WINDOW", 150),
    maxTradesPerWindow: num("MAX_TRADES_PER_WINDOW", 5),
    maxDailyTrades: num("MAX_DAILY_TRADES", 200),
    maxDailyLossUsd: num("MAX_DAILY_LOSS_USD", 25),
    maxConsecutiveFailures: num("MAX_CONSECUTIVE_FAILURES", 3),
    tradeCooldownMs: num("TRADE_COOLDOWN_MS", 2000),
    noTradeLastSeconds: num("NO_TRADE_LAST_SECONDS", 10),
    maxBookAgeMs: num("MAX_BOOK_AGE_MS", 60_000),
    hedgeMaxLossPerShare: num("HEDGE_MAX_LOSS_PER_SHARE", 0.03),
    hedgeAttempts: num("HEDGE_ATTEMPTS", 3),
    hedgeRetryDelayMs: num("HEDGE_RETRY_DELAY_MS", 300),
    unhedgedAction,
    unwindSlippageTicks: num("UNWIND_SLIPPAGE_TICKS", 2),
    paperLatencyMs: num("PAPER_LATENCY_MS", 250),
    defaultFee: { rate: num("DEFAULT_FEE_RATE", 0.07), exponent: num("DEFAULT_FEE_EXPONENT", 1), takerOnly: true },
    logDir: str("LOG_DIR", "./logs"),
    statusIntervalMs: num("STATUS_INTERVAL_MS", 15_000),
    privateKey: str("POLY_PRIVATE_KEY"),
    signatureType: parseSignatureType(str("POLY_SIGNATURE_TYPE", str("POLY_WALLET_TYPE", "0"))),
    funderAddress: str("POLY_FUNDER"),
    rpcUrl: str("POLY_RPC_URL", "https://polygon-rpc.com"),
    apiKey: str("CLOB_API_KEY"),
    apiSecret: str("CLOB_SECRET"),
    apiPassphrase: str("CLOB_PASSPHRASE"),
  };

  if (cfg.minEdge < 0) throw new Error("MIN_EDGE must be >= 0");
  if (cfg.noTradeLastSeconds < 5) {
    throw new Error("NO_TRADE_LAST_SECONDS must be >= 5 so a one-sided fill can be repaired before the books close");
  }
  if (cfg.slippageTicks < 0 || !Number.isInteger(cfg.slippageTicks)) throw new Error("SLIPPAGE_TICKS must be a non-negative integer");
  if (cfg.mode === "live") {
    if (!cfg.privateKey) throw new Error("TRADING_MODE=live requires POLY_PRIVATE_KEY");
    if (cfg.signatureType !== 0 && !cfg.funderAddress) {
      throw new Error("POLY_FUNDER (your Polymarket wallet address) is required for proxy/safe wallets");
    }
  }
  return cfg;
}
