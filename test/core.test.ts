import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { feePerShare, takerFee, maxFeePerShareInRange } from "../src/core/fees";
import { OrderBook } from "../src/core/orderbook";
import {
  findOpportunity,
  hedgedDirections,
  maxProfitablePairs,
  shareGranularity,
  type ArbParams,
  type MarketQuotes,
} from "../src/core/arbitrage";
import { pairWindowAt, eventSlug } from "../src/core/windows";
import type { BookLevel, FeeSchedule, Horizon, MarketInfo } from "../src/types";

const CRYPTO_FEE: FeeSchedule = { rate: 0.07, exponent: 1, takerOnly: true };
const NO_FEE: FeeSchedule = { rate: 0, exponent: 1, takerOnly: true };

function market(horizon: Horizon, overrides: Partial<MarketInfo> = {}): MarketInfo {
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
    fee: CRYPTO_FEE,
    negRisk: false,
    acceptingOrders: true,
    closed: false,
    ...overrides,
  };
}

const params: ArbParams = {
  minEdge: 0.01,
  minProfitUsd: 0,
  maxShares: 1000,
  maxCostUsd: 10_000,
  slippageTicks: 0,
  minOrderUsd: 1,
};

const lv = (price: number, size: number): BookLevel => ({ price, size });

describe("fees", () => {
  it("matches the published crypto curve (1.75c per share at 0.50)", () => {
    assert.equal(feePerShare(0.5, CRYPTO_FEE), 0.0175);
    assert.equal(takerFee(100, 0.5, CRYPTO_FEE), 1.75);
    assert.ok(Math.abs(feePerShare(0.2, CRYPTO_FEE) - 0.07 * 0.16) < 1e-12);
  });

  it("is zero at the edges and for fee-free markets", () => {
    assert.equal(feePerShare(0, CRYPTO_FEE), 0);
    assert.equal(feePerShare(1, CRYPTO_FEE), 0);
    assert.equal(feePerShare(0.5, NO_FEE), 0);
  });

  it("finds the max fee inside a price range", () => {
    assert.equal(maxFeePerShareInRange(0.4, 0.6, CRYPTO_FEE), feePerShare(0.5, CRYPTO_FEE));
    assert.equal(maxFeePerShareInRange(0.1, 0.2, CRYPTO_FEE), feePerShare(0.2, CRYPTO_FEE));
    assert.equal(maxFeePerShareInRange(0.7, 0.9, CRYPTO_FEE), feePerShare(0.7, CRYPTO_FEE));
  });
});

describe("OrderBook", () => {
  it("sorts levels regardless of the CLOB's worst-first ordering", () => {
    const book = new OrderBook("t");
    book.applySnapshot(
      [lv(0.01, 100), lv(0.3, 5), lv(0.45, 10)],
      [lv(0.99, 100), lv(0.6, 20), lv(0.46, 10)],
      1,
    );
    assert.equal(book.bestAsk(), 0.46);
    assert.equal(book.bestBid(), 0.45);
    assert.deepEqual(book.asksAscending().map((l) => l.price), [0.46, 0.6, 0.99]);
  });

  it("applies level updates and removals", () => {
    const book = new OrderBook("t");
    book.applySnapshot([lv(0.4, 10)], [lv(0.5, 10)], 1);
    book.applyLevel("SELL", 0.48, 7, 2);
    book.applyLevel("SELL", 0.5, 0, 3);
    book.applyLevel("BUY", 0.41, 3, 4);
    assert.deepEqual(book.asksAscending(), [lv(0.48, 7)]);
    assert.equal(book.bestBid(), 0.41);
  });

  it("quotes a buy across levels with a limit", () => {
    const book = new OrderBook("t");
    book.applySnapshot([], [lv(0.4, 10), lv(0.42, 10), lv(0.5, 100)], 1);
    const q = book.quoteBuy(15);
    assert.equal(q.shares, 15);
    assert.ok(Math.abs(q.cost - (10 * 0.4 + 5 * 0.42)) < 1e-12);
    assert.equal(q.worstPrice, 0.42);
    const limited = book.quoteBuy(50, 0.42);
    assert.equal(limited.shares, 20);
  });
});

describe("pair selection", () => {
  it("buys UP where the strike is lower and DOWN where it is higher", () => {
    assert.deepEqual(hedgedDirections(100, 101), [{ up: "5m", down: "15m" }]);
    assert.deepEqual(hedgedDirections(101, 100), [{ up: "15m", down: "5m" }]);
    assert.equal(hedgedDirections(100, 100).length, 2);
  });

  it("covers every settlement price (UP wins on ties)", () => {
    for (const [b5, b15] of [
      [100, 101],
      [101, 100],
      [100, 100],
    ]) {
      for (const dir of hedgedDirections(b5, b15)) {
        const upStrike = dir.up === "5m" ? b5 : b15;
        const downStrike = dir.down === "5m" ? b5 : b15;
        for (let f = 98; f <= 103; f += 0.25) {
          const payout = (f >= upStrike ? 1 : 0) + (f < downStrike ? 1 : 0);
          assert.ok(payout >= 1, `final=${f} b5=${b5} b15=${b15} dir=${JSON.stringify(dir)}`);
        }
      }
    }
  });
});

describe("sizing", () => {
  it("walks both ladders while the marginal pair stays profitable", () => {
    const up = [lv(0.4, 10), lv(0.45, 10), lv(0.6, 10)];
    const down = [lv(0.5, 15), lv(0.52, 100)];
    // 0.40+0.50 and 0.45+0.50 / 0.45+0.52 clear 1% after fees; 0.60+0.52 does not.
    const n = maxProfitablePairs(up, down, NO_FEE, NO_FEE, { minEdge: 0.01, maxShares: 1000, maxCostUsd: 1e9 });
    assert.equal(n, 20);
  });

  it("respects share and cost caps", () => {
    const up = [lv(0.4, 100)];
    const down = [lv(0.5, 100)];
    assert.equal(maxProfitablePairs(up, down, NO_FEE, NO_FEE, { minEdge: 0, maxShares: 30, maxCostUsd: 1e9 }), 30);
    assert.ok(Math.abs(maxProfitablePairs(up, down, NO_FEE, NO_FEE, { minEdge: 0, maxShares: 1e9, maxCostUsd: 9 }) - 10) < 1e-9);
  });

  it("uses whole shares at 0.01 ticks and tens at 0.001 ticks", () => {
    assert.equal(shareGranularity(0.01), 1);
    assert.equal(shareGranularity(0.001), 10);
    assert.equal(shareGranularity(0.005), 10);
    assert.equal(shareGranularity(0.0025), 100);
  });
});

describe("findOpportunity", () => {
  const quotes = (horizon: Horizon, upAsks: BookLevel[], downAsks: BookLevel[], o: Partial<MarketInfo> = {}): MarketQuotes => ({
    market: market(horizon, o),
    upAsks,
    downAsks,
  });

  it("detects a locked-in profit net of fees", () => {
    // beat5m < beat15m -> UP in 5m + DOWN in 15m.
    const q5 = quotes("5m", [lv(0.42, 50)], [lv(0.6, 50)]);
    const q15 = quotes("15m", [lv(0.6, 50)], [lv(0.45, 50)]);
    const opp = findOpportunity(q5, q15, 100_000, 100_050, params, 0);
    assert.ok(opp);
    assert.equal(opp.up.horizon, "5m");
    assert.equal(opp.down.horizon, "15m");
    assert.equal(opp.shares, 50);
    const fees = 50 * (feePerShare(0.42, CRYPTO_FEE) + feePerShare(0.45, CRYPTO_FEE));
    assert.ok(Math.abs(opp.totalCost - (50 * 0.87 + fees)) < 1e-4);
    assert.ok(opp.expectedProfit > 0);
    assert.ok(opp.worstCaseCost <= opp.shares);
    assert.deepEqual(opp.bothWinBand, { from: 100_000, to: 100_050 });
  });

  it("ignores the cheap but unhedged combination", () => {
    // UP15 + DOWN5 is cheap, but with beat5m < beat15m it leaves [b5, b15) uncovered.
    const q5 = quotes("5m", [lv(0.6, 50)], [lv(0.4, 50)]);
    const q15 = quotes("15m", [lv(0.4, 50)], [lv(0.6, 50)]);
    assert.equal(findOpportunity(q5, q15, 100_000, 100_050, params, 0), null);
    assert.ok(findOpportunity(q5, q15, 100_050, 100_000, params, 0));
  });

  it("rejects when fees eat the edge", () => {
    const q5 = quotes("5m", [lv(0.49, 50)], [lv(0.6, 50)]);
    const q15 = quotes("15m", [lv(0.6, 50)], [lv(0.5, 50)]);
    // 0.99 + ~3.5c fees > 1.
    assert.equal(findOpportunity(q5, q15, 1, 2, params, 0), null);
  });

  it("rejects mismatched end times and too-small sizes", () => {
    const q5 = quotes("5m", [lv(0.4, 3)], [lv(0.6, 50)]);
    const q15 = quotes("15m", [lv(0.6, 50)], [lv(0.4, 3)]);
    assert.equal(findOpportunity(q5, q15, 1, 2, params, 0), null, "below 5-share minimum");
    const q15b = quotes("15m", [lv(0.6, 50)], [lv(0.4, 50)], { endTime: 1800 });
    const q5b = quotes("5m", [lv(0.4, 50)], [lv(0.6, 50)]);
    assert.equal(findOpportunity(q5b, q15b, 1, 2, params, 0), null);
  });

  it("drops slippage ticks that would allow a worst-case loss", () => {
    const q5 = quotes("5m", [lv(0.49, 50)], [lv(0.6, 50)]);
    const q15 = quotes("15m", [lv(0.6, 50)], [lv(0.47, 50)]);
    const loose = { ...params, minEdge: 0, slippageTicks: 3 };
    const opp = findOpportunity(q5, q15, 1, 2, loose, 0);
    assert.ok(opp);
    assert.ok(opp.worstCaseCost <= opp.shares + 1e-9);
    assert.ok(opp.up.limitPrice + opp.down.limitPrice < 1);
  });
});

describe("windows", () => {
  it("aligns the last 5m window with the 15m window end", () => {
    const w = pairWindowAt(1791998959);
    assert.equal(w.start15m, 1791998100);
    assert.equal(w.start5m, 1791998700);
    assert.equal(w.end, 1791999000);
    assert.equal(eventSlug("btc", "5m", w.start5m), "btc-updown-5m-1791998700");
  });
});
