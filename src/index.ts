/**
 * Entry point: `npm start` (compiled) or `npm run dev` (ts-node).
 */

import "dotenv/config";
import { loadConfig } from "./config";
import { ArbitrageBot } from "./services/bot";
import { PaperVenue } from "./execution/paper-venue";
import { LiveVenue } from "./execution/live-venue";
import type { Venue } from "./execution/venue";
import { Redeemer } from "./services/redeemer";
import { Journal } from "./services/journal";
import { logError, logInfo, logWarn, setLogLevel } from "./utils/logger";

async function main(): Promise<void> {
  if (process.env.LOG_LEVEL) setLogLevel(process.env.LOG_LEVEL);
  const cfg = loadConfig();

  // The bot needs the market stream's books for paper fills, so the paper venue
  // reads them through a late-bound accessor.
  let bot: ArbitrageBot | null = null;
  let venue: Venue;
  if (cfg.mode === "live") {
    logWarn("LIVE TRADING ENABLED: real orders will be sent to Polymarket.");
    venue = new LiveVenue({
      privateKey: cfg.privateKey,
      signatureType: cfg.signatureType,
      funderAddress: cfg.funderAddress || undefined,
      rpcUrl: cfg.rpcUrl,
      apiCreds:
        cfg.apiKey && cfg.apiSecret && cfg.apiPassphrase
          ? { key: cfg.apiKey, secret: cfg.apiSecret, passphrase: cfg.apiPassphrase }
          : undefined,
    });
  } else {
    logInfo("Paper trading: no orders are sent. Set TRADING_MODE=live to trade for real.");
    venue = new PaperVenue((tokenId) => bot?.book(tokenId), cfg.paperLatencyMs);
  }

  bot = new ArbitrageBot(cfg, venue);
  await bot.start();

  let redeemer: Redeemer | null = null;
  if (cfg.mode === "live" && cfg.autoRedeem) {
    const r = new Redeemer(cfg, new Journal(cfg.logDir));
    try {
      if (await r.init()) {
        r.start();
        redeemer = r;
      }
    } catch (err) {
      logError(`Auto-redeem disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logInfo(`Received ${signal}, shutting down...`);
    redeemer?.stop();
    await bot?.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logError("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
