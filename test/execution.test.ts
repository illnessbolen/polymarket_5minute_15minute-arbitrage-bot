import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OrderBook } from "../src/core/orderbook";
import { findOpportunity } from "../src/core/arbitrage";
import { TradeExecutor, type RepairConfig } from "../src/execution/executor";
import { PaperVenue } from "../src/execution/paper-venue";
import { emptyFill, type OrderRequest } from "../src/execution/venue";
import { WindowLedger } from "../src/services/positions";
import type { BookLevel, Horizon, LegFill, MarketInfo } from "../src/types";

const FEE = { rate: 0.07, exponent: 1, takerOnly: true };

function market(horizon: Horizon): MarketInfo {
  return {
    asset: "btc",
    horizon,
    slug: `btc-updown-${horizon}-0`,
    eventId: "1",
    conditionId: `0x${horizon}`,
    title: horizon,
    startTime: horizon === "5m" ? 600 : 0,
    endTime: 900,
    upTokenId: `${horizon}-up`,
    downTokenId: `${horizon}-down`,
    tickSize: 0.01,
    minOrderSize: 5,
    fee: FEE,
    negRisk: false,
    acceptingOrders: true,
    closed: false,
  };
}

const lv = (price: number, size: number): BookLevel => ({ price, size });

function setup(asks: Record<string, BookLevel[]>, bids: Record<string, BookLevel[]> = {}) {
  const books = new Map<string, OrderBook>();
  for (const id of ["5m-up", "5m-down", "15m-up", "15m-down"]) {
    const b = new OrderBook(id);
    b.applySnapshot(bids[id] ?? [lv(0.3, 100)], asks[id] ?? [lv(0.99, 100)], 1);
    books.set(id, b);
  }
  const markets = new Map<string, MarketInfo>();
  for (const m of [market("5m"), market("15m")]) {
    markets.set(m.upTokenId, m);
    markets.set(m.downTokenId, m);
  }
  const quotes = (h: Horizon) => ({
    market: market(h),
    upAsks: books.get(`${h}-up`)!.asksAscending(),
    downAsks: books.get(`${h}-down`)!.asksAscending(),
  });
  return { books, markets, quotes };
}

/** Paper venue whose pair submission fills only the UP leg (the DOWN leg is "killed"). */
class OneSidedVenue extends PaperVenue {
  async buyPair(up: OrderRequest, down: OrderRequest): Promise<[LegFill, LegFill]> {
    const [u] = await super.buyPair(up, down);
    return [u, emptyFill(down, "BUY", "killed", "simulated miss")];
  }
}

const repair: RepairConfig = {
  hedgeMaxLossPerShare: 0.03,
  hedgeAttempts: 2,
  hedgeRetryDelayMs: 0,
  unhedgedAction: "sell",
  unwindSlippageTicks: 2,
};

const params = { minEdge: 0.01, minProfitUsd: 0, maxShares: 20, maxCostUsd: 1000, slippageTicks: 0, minOrderUsd: 1 };

describe("TradeExecutor", () => {
  it("fills both legs when the book holds", async () => {
    const { books, markets, quotes } = setup({ "5m-up": [lv(0.42, 50)], "15m-down": [lv(0.45, 50)] });
    const opp = findOpportunity(quotes("5m"), quotes("15m"), 100, 101, params)!;
    assert.ok(opp);
    const ex = new TradeExecutor(new PaperVenue((id) => books.get(id), 0), (id) => books.get(id), (id) => markets.get(id), repair);
    const res = await ex.execute(opp);
    assert.equal(res.status, "filled");
    assert.equal(res.up.sharesFilled, 20);
    assert.equal(res.down.sharesFilled, 20);
    assert.equal(res.repairs.length, 0);
  });

  it("completes a broken hedge when the missing leg is still affordable", async () => {
    const { books, markets, quotes } = setup({ "5m-up": [lv(0.42, 50)], "15m-down": [lv(0.45, 50)] });
    const opp = findOpportunity(quotes("5m"), quotes("15m"), 100, 101, params)!;
    // Missing leg now costs 0.55: 0.42 + 0.55 + fees < 1.03.
    books.get("15m-down")!.applySnapshot([], [lv(0.55, 50)], 2);
    const ex = new TradeExecutor(new OneSidedVenue((id) => books.get(id), 0), (id) => books.get(id), (id) => markets.get(id), repair);
    const res = await ex.execute(opp);
    assert.equal(res.status, "hedged");
    assert.equal(res.repairs.length, 1);
    assert.equal(res.repairs[0].side, "BUY");
    assert.equal(res.repairs[0].sharesFilled, 20);
  });

  it("sells the excess when the hedge became too expensive", async () => {
    const { books, markets, quotes } = setup(
      { "5m-up": [lv(0.42, 50)], "15m-down": [lv(0.45, 50)] },
      { "5m-up": [lv(0.4, 100)] },
    );
    const opp = findOpportunity(quotes("5m"), quotes("15m"), 100, 101, params)!;
    books.get("15m-down")!.applySnapshot([], [lv(0.7, 50)], 2);
    const ex = new TradeExecutor(new OneSidedVenue((id) => books.get(id), 0), (id) => books.get(id), (id) => markets.get(id), repair);
    const res = await ex.execute(opp);
    assert.equal(res.status, "unwound");
    const sell = res.repairs.find((r) => r.side === "SELL")!;
    assert.equal(sell.sharesFilled, 20);
    assert.ok(Math.abs(sell.cost - 20 * 0.4) < 1e-9);
  });

  it("keeps the position when configured to hold", async () => {
    const { books, markets, quotes } = setup({ "5m-up": [lv(0.42, 50)], "15m-down": [lv(0.45, 50)] });
    const opp = findOpportunity(quotes("5m"), quotes("15m"), 100, 101, params)!;
    books.get("15m-down")!.applySnapshot([], [lv(0.7, 50)], 2);
    const ex = new TradeExecutor(new OneSidedVenue((id) => books.get(id), 0), (id) => books.get(id), (id) => markets.get(id), {
      ...repair,
      unhedgedAction: "hold",
    });
    const res = await ex.execute(opp);
    assert.equal(res.status, "unhedged");
  });

  it("reports rejection when nothing fills", async () => {
    const { books, markets, quotes } = setup({ "5m-up": [lv(0.42, 50)], "15m-down": [lv(0.45, 50)] });
    const opp = findOpportunity(quotes("5m"), quotes("15m"), 100, 101, params)!;
    books.get("5m-up")!.applySnapshot([], [lv(0.6, 50)], 2);
    books.get("15m-down")!.applySnapshot([], [lv(0.6, 50)], 2);
    const ex = new TradeExecutor(new PaperVenue((id) => books.get(id), 0), (id) => books.get(id), (id) => markets.get(id), repair);
    const res = await ex.execute(opp);
    assert.equal(res.status, "rejected");
  });
});

describe("WindowLedger", () => {
  const fill = (tokenId: string, outcome: "UP" | "DOWN", horizon: Horizon, side: "BUY" | "SELL", shares: number, cost: number, fee = 0): LegFill => ({
    side,
    tokenId,
    outcome,
    horizon,
    sharesFilled: shares,
    cost,
    fee,
    status: "matched",
  });

  it("locks in the hedge profit for every settlement price", () => {
    const l = new WindowLedger();
    l.apply(fill("5m-up", "UP", "5m", "BUY", 10, 4.2, 0.17));
    l.apply(fill("15m-down", "DOWN", "15m", "BUY", 10, 4.5, 0.17));
    // beat5m < beat15m: UP5 + DOWN15 pays >= 10 everywhere, 20 in between.
    assert.equal(l.minPayout(100, 101), 10);
    assert.equal(l.payout({ "5m": "UP", "15m": "DOWN" }), 20);
    assert.equal(l.payout({ "5m": "DOWN", "15m": "DOWN" }), 10);
    assert.ok(Math.abs(l.netCash - 9.04) < 1e-9);
  });

  it("nets out sells", () => {
    const l = new WindowLedger();
    l.apply(fill("5m-up", "UP", "5m", "BUY", 10, 4.2, 0.1));
    l.apply(fill("5m-up", "UP", "5m", "SELL", 10, 4.0, 0.1));
    assert.equal(l.positions.get("5m-up")!.shares, 0);
    assert.ok(Math.abs(l.netCash - 0.4) < 1e-9);
  });
});
