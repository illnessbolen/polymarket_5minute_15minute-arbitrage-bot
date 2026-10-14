/**
 * Summarize the JSONL journal: windows observed, opportunities, trades, PnL.
 *
 * Usage: npm run report [-- <log dir>]
 */

import "dotenv/config";
import { Journal } from "../services/journal";

const dir = process.argv[2] ?? process.env.LOG_DIR ?? "./logs";

const windows = Journal.read(dir, "windows");
const trades = Journal.read(dir, "trades");
const opportunities = Journal.read(dir, "opportunities");
const events = Journal.read(dir, "events");

console.log(`Journal: ${dir}`);
console.log(`Windows settled: ${windows.length}`);

const minCosts = windows.map((w) => w.minPairCost).filter((c): c is number => typeof c === "number");
if (minCosts.length > 0) {
  const sorted = [...minCosts].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(4);
  console.log(`Cheapest hedged pair per window (asks + fees): min ${pct(0)}, p10 ${pct(0.1)}, median ${pct(0.5)}`);
  console.log(`Windows where the pair cost dipped below 1.00: ${minCosts.filter((c) => c < 1).length}`);
}

console.log(`Opportunities detected: ${opportunities.length}`);
const byStatus = new Map<string, number>();
for (const t of trades) byStatus.set(String(t.status), (byStatus.get(String(t.status)) ?? 0) + 1);
console.log(`Trades: ${trades.length}${byStatus.size ? ` (${[...byStatus].map(([s, n]) => `${s} ${n}`).join(", ")})` : ""}`);

const pnls = windows.map((w) => w.pnl).filter((p): p is number => typeof p === "number");
const total = pnls.reduce((a, b) => a + b, 0);
console.log(`Settled PnL: ${total.toFixed(2)} USD over ${pnls.length} window(s) with positions`);

const mismatches = events.filter((e) => e.type === "beat_mismatch");
console.log(`Price-to-beat mismatches vs Gamma: ${mismatches.length}`);
const halts = events.filter((e) => e.type === "reconcile_mismatch");
if (halts.length) console.log(`Balance reconciliation problems: ${halts.length}`);
