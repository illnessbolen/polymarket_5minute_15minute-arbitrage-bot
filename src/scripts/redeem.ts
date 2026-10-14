/**
 * Redeem resolved positions once.
 *
 * Usage: npm run redeem            # dry run: simulate and show what would be redeemed
 *        npm run redeem -- --yes   # send the redeem transactions
 *        npm run redeem -- --all   # include every resolved binary market, not only up/down ones
 */

import "dotenv/config";
import { loadConfig } from "../config";
import { Redeemer } from "../services/redeemer";
import { Journal } from "../services/journal";
import { setLogLevel } from "../utils/logger";

async function main(): Promise<void> {
  if (process.env.LOG_LEVEL) setLogLevel(process.env.LOG_LEVEL);
  const send = process.argv.includes("--yes");
  const cfg = loadConfig();
  if (!cfg.privateKey) throw new Error("Set POLY_PRIVATE_KEY (and POLY_FUNDER for proxy/Safe wallets) in .env");
  if (cfg.signatureType !== 0 && !cfg.funderAddress) throw new Error("POLY_FUNDER is required for proxy/Safe wallets");
  if (process.argv.includes("--all")) cfg.redeemScope = "all";

  const redeemer = new Redeemer(cfg, send ? new Journal(cfg.logDir) : null);
  if (!(await redeemer.init(!send))) return;
  const outcomes = await redeemer.runOnce(!send);

  if (outcomes.length === 0) {
    console.log(`Nothing to redeem (minimum payout ${cfg.redeemMinPayoutUsd} pUSD, scope "${cfg.redeemScope}").`);
    return;
  }
  for (const o of outcomes) {
    const what = o.candidate.slug || o.candidate.conditionId;
    const amount = o.payout !== undefined ? `${o.payout.toFixed(2)} pUSD` : "";
    console.log(`${o.status.padEnd(9)} ${what} ${amount}${o.txHash ? ` tx ${o.txHash}` : ""}${o.reason ? ` (${o.reason})` : ""}`);
  }
  if (!send && outcomes.some((o) => o.status === "simulated")) {
    console.log("\nDry run. Run `npm run redeem -- --yes` to send these transactions.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
