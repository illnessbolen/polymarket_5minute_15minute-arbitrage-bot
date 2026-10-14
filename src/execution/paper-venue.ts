/**
 * Paper trading: orders are "filled" against the live order book after a
 * simulated delay (network round trip + Polymarket's taker delay on crypto
 * markets), so a fleeting opportunity can still be missed as it would be live.
 * Paper fills do not consume liquidity.
 */

import type { LegFill, MarketInfo } from "../types";
import type { OrderBook } from "../core/orderbook";
import { takerFeeForFills } from "../core/fees";
import { emptyFill, type OrderRequest, type TimeInForce, type Venue } from "./venue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PaperVenue implements Venue {
  readonly mode = "paper" as const;

  constructor(
    private readonly books: (tokenId: string) => OrderBook | undefined,
    private readonly latencyMs: number,
  ) {}

  async init(): Promise<void> {}

  async prepareMarket(_market: MarketInfo): Promise<void> {}

  async buyPair(up: OrderRequest, down: OrderRequest): Promise<[LegFill, LegFill]> {
    await sleep(this.latencyMs);
    return [this.fill(up, "BUY", "FOK"), this.fill(down, "BUY", "FOK")];
  }

  async buy(req: OrderRequest, tif: TimeInForce): Promise<LegFill> {
    await sleep(this.latencyMs);
    return this.fill(req, "BUY", tif);
  }

  async sell(req: OrderRequest, tif: TimeInForce): Promise<LegFill> {
    await sleep(this.latencyMs);
    return this.fill(req, "SELL", tif);
  }

  private fill(req: OrderRequest, side: "BUY" | "SELL", tif: TimeInForce): LegFill {
    const book = this.books(req.tokenId);
    if (!book || !book.ready) return emptyFill(req, side, "rejected", "no order book");
    const quote = side === "BUY" ? book.quoteBuy(req.shares, req.limitPrice) : book.quoteSell(req.shares, req.limitPrice);
    if (quote.shares <= 0 || (tif === "FOK" && quote.shares + 1e-9 < req.shares)) {
      return emptyFill(req, side, "killed", `only ${quote.shares.toFixed(2)} of ${req.shares} shares within limit ${req.limitPrice}`);
    }
    return {
      side,
      tokenId: req.tokenId,
      outcome: req.outcome,
      horizon: req.horizon,
      sharesFilled: quote.shares,
      cost: quote.cost,
      fee: takerFeeForFills(quote.fills, req.fee),
      status: "matched",
    };
  }
}
