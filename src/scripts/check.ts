/**
 * Preflight check: data sources, current markets and (optionally) the wallet.
 *
 * Usage: npm run check              # market data only
 *        npm run check -- --wallet  # also authenticate with the CLOB and show the balance
 */

import "dotenv/config";
import { loadConfig } from "../config";
import { GammaClient } from "../feeds/gamma";
import { ChainlinkTwapFeed, assetSymbol } from "../feeds/chainlink-twap";
import { pairWindowAt } from "../core/windows";
import { feePerShare } from "../core/fees";
import { fetchJson } from "../utils/http";
import { LiveVenue } from "../execution/live-venue";
import { setLogLevel } from "../utils/logger";

interface RestBook {
  asks: Array<{ price: string; size: string }>;
}

async function bestAsk(tokenId: string): Promise<number | null> {
  const book = await fetchJson<RestBook>(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  const prices = book.asks.map((a) => Number(a.price));
  return prices.length ? Math.min(...prices) : null;
}

async function main(): Promise<void> {
  setLogLevel("warn");
  const cfg = loadConfig();
  console.log(`Mode: ${cfg.mode} | assets: ${cfg.assets.join(", ")} | min edge ${cfg.minEdge} | max $${cfg.maxUsdPerTrade}/trade`);

  const twap = new ChainlinkTwapFeed(new Set(cfg.assets.map(assetSymbol)));
  twap.start();

  const gamma = new GammaClient(cfg.defaultFee);
  const w = pairWindowAt(Math.floor(Date.now() / 1000));
  console.log(`\nCurrent window settles at ${new Date(w.end * 1000).toISOString()}`);
  for (const asset of cfg.assets) {
    const [m15, m5] = await Promise.all([gamma.fetchMarket(asset, "15m", w.start15m), gamma.fetchMarket(asset, "5m", w.start5m)]);
    if (!m15 || !m5) {
      console.log(`  ${asset}: markets not found (${!m15 ? "15m " : ""}${!m5 ? "5m" : ""})`);
      continue;
    }
    const [u5, d5, u15, d15] = await Promise.all([m5.upTokenId, m5.downTokenId, m15.upTokenId, m15.downTokenId].map(bestAsk));
    const cost = (a: number | null, b: number | null, fee = m5.fee) =>
      a === null || b === null ? "—" : (a + b + feePerShare(a, fee) + feePerShare(b, fee)).toFixed(4);
    console.log(
      `  ${asset.padEnd(5)} tick ${m5.tickSize}/${m15.tickSize} fee ${m5.fee.rate} | asks UP5 ${u5} DOWN5 ${d5} UP15 ${u15} DOWN15 ${d15} | ` +
        `pair cost UP5+DOWN15 ${cost(u5, d15)} (hedge if 5m strike <= 15m), UP15+DOWN5 ${cost(u15, d5)} (hedge if 5m strike >= 15m)`,
    );
  }
  console.log("  Only the combination matching the strikes is a hedge; the bot picks it from the Chainlink TWAP strikes.");

  await new Promise((r) => setTimeout(r, 4000));
  console.log("\nChainlink TWAP (60s) feed:");
  for (const asset of cfg.assets) {
    const v = twap.latestValue(assetSymbol(asset));
    console.log(`  ${asset.padEnd(5)} ${v ? `${v.value} @ ${new Date(v.sec * 1000).toISOString()}` : "no data yet"}`);
  }
  twap.stop();

  if (process.argv.includes("--wallet")) {
    console.log("\nWallet:");
    setLogLevel("info");
    const venue = new LiveVenue({
      privateKey: cfg.privateKey,
      signatureType: cfg.signatureType,
      funderAddress: cfg.funderAddress || undefined,
      rpcUrl: cfg.rpcUrl,
      apiCreds: cfg.apiKey ? { key: cfg.apiKey, secret: cfg.apiSecret, passphrase: cfg.apiPassphrase } : undefined,
    });
    await venue.init();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
