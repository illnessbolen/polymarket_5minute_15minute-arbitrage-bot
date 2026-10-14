/**
 * CLOB market channel: keeps a local order book per subscribed token.
 * https://docs.polymarket.com/developers/CLOB/websocket/market-channel
 *
 * Messages used:
 *   book             full snapshot for one token
 *   price_change     aggregate size at a level changed (side BUY = bid, SELL = ask)
 *   best_bid_ask     top of book after any change (incl. trades)
 *   tick_size_change tick size switched (e.g. 0.01 -> 0.001 near 0/1)
 * Trades do not emit price_change; the exchange re-sends `book` after them,
 * and in between the reported best bid/ask is used to trim consumed levels.
 */

import { EventEmitter } from "events";
import { OrderBook } from "../core/orderbook";
import type { BookLevel } from "../types";
import { ManagedSocket } from "./socket";
import { logDebug, logWarn } from "../utils/logger";

const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

interface RawLevel {
  price: string;
  size: string;
}

interface RawMessage {
  event_type?: string;
  asset_id?: string;
  timestamp?: string;
  hash?: string;
  bids?: RawLevel[];
  asks?: RawLevel[];
  tick_size?: string;
  new_tick_size?: string;
  best_bid?: string;
  best_ask?: string;
  price_changes?: Array<{
    asset_id: string;
    price: string;
    size: string;
    side: "BUY" | "SELL";
    best_bid?: string;
    best_ask?: string;
  }>;
}

const toLevels = (raw: RawLevel[] | undefined): BookLevel[] =>
  (raw ?? []).map((l) => ({ price: Number(l.price), size: Number(l.size) }));

export declare interface MarketStream {
  on(event: "update", listener: (tokenId: string) => void): this;
  on(event: "tickSize", listener: (tokenId: string, tickSize: number) => void): this;
}

export class MarketStream extends EventEmitter {
  private readonly books = new Map<string, OrderBook>();
  private readonly socket: ManagedSocket;
  private desyncs = 0;
  private resyncTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastResyncAt = 0;

  constructor() {
    super();
    this.socket = new ManagedSocket({
      name: "clob-market",
      url: MARKET_WS_URL,
      pingIntervalMs: 10_000,
      staleAfterMs: 30_000,
      onOpen: (send) => {
        for (const book of this.books.values()) book.reset();
        if (this.books.size > 0) {
          send({ assets_ids: [...this.books.keys()], type: "market", custom_feature_enabled: true });
        }
      },
      onMessage: (text) => this.handle(text),
      onClose: () => {
        for (const book of this.books.values()) book.reset();
      },
    });
  }

  start(): void {
    this.socket.start();
    this.watchdog = setInterval(() => this.resyncIfStale(), 5_000);
  }

  stop(): void {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.resyncTimer = null;
    this.watchdog = null;
    this.socket.stop();
  }

  get connected(): boolean {
    return this.socket.isOpen;
  }

  book(tokenId: string): OrderBook | undefined {
    return this.books.get(tokenId);
  }

  /**
   * Replace the subscribed token set. The market channel takes its asset list
   * at connect time, so a changed set triggers a reconnect; callers change the
   * set only at window boundaries.
   */
  setTokens(tokenIds: string[]): void {
    const next = new Set(tokenIds);
    const same = next.size === this.books.size && [...next].every((t) => this.books.has(t));
    if (same) return;
    for (const id of [...this.books.keys()]) if (!next.has(id)) this.books.delete(id);
    for (const id of next) if (!this.books.has(id)) this.books.set(id, new OrderBook(id));
    if (this.books.size > 0) this.socket.restart();
    else this.socket.stop();
  }

  private handle(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logDebug(`[clob-market] non-JSON message: ${text.slice(0, 120)}`);
      return;
    }
    const messages = (Array.isArray(parsed) ? parsed : [parsed]) as RawMessage[];
    const touched = new Set<string>();

    for (const msg of messages) {
      const ts = Number(msg.timestamp) || Date.now();
      switch (msg.event_type) {
        case "book": {
          const book = msg.asset_id ? this.books.get(msg.asset_id) : undefined;
          if (!book) break;
          book.applySnapshot(toLevels(msg.bids), toLevels(msg.asks), ts, msg.hash);
          if (msg.tick_size) book.tickSize = Number(msg.tick_size);
          touched.add(book.tokenId);
          break;
        }
        case "price_change": {
          for (const ch of msg.price_changes ?? []) {
            const book = this.books.get(ch.asset_id);
            if (!book || !book.ready) continue;
            book.applyLevel(ch.side, Number(ch.price), Number(ch.size), ts);
            touched.add(book.tokenId);
            this.reconcileTop(book, ch.best_bid, ch.best_ask);
          }
          break;
        }
        case "best_bid_ask": {
          const book = msg.asset_id ? this.books.get(msg.asset_id) : undefined;
          if (!book || !book.ready) break;
          // best_bid_ask can arrive a few ms before the price_change that adds a
          // new level, so it is only used to drop consumed levels.
          this.reconcileTop(book, msg.best_bid, msg.best_ask, false);
          touched.add(book.tokenId);
          break;
        }
        case "tick_size_change": {
          const book = msg.asset_id ? this.books.get(msg.asset_id) : undefined;
          const tick = Number(msg.new_tick_size);
          if (book && tick > 0) {
            book.tickSize = tick;
            this.emit("tickSize", book.tokenId, tick);
          }
          break;
        }
        default:
          break;
      }
    }
    for (const tokenId of touched) this.emit("update", tokenId);
  }

  /**
   * Reconcile the local top of book with the best bid/ask reported by the feed.
   * Trades remove liquidity without a price_change (a fresh `book` follows
   * shortly), so levels better than the reported best are trimmed. A reported
   * best that is better than anything we hold means we missed an update: the
   * book is marked unready until the next snapshot or a resubscribe.
   */
  private reconcileTop(book: OrderBook, bestBid?: string, bestAsk?: string, detectGaps = true): void {
    const bid = Number(bestBid);
    const ask = Number(bestAsk);
    const hasBid = bestBid !== undefined && bid > 0 && bid < 1;
    const hasAsk = bestAsk !== undefined && ask > 0 && ask < 1;
    if (hasBid) book.trimBidsAbove(bid);
    if (hasAsk) book.trimAsksBelow(ask);
    if (!detectGaps) return;

    const localBid = book.bestBid();
    const localAsk = book.bestAsk();
    const missingBid = hasBid && (localBid === null || localBid < bid - 1e-9);
    const missingAsk = hasAsk && (localAsk === null || localAsk > ask + 1e-9);
    if (!missingBid && !missingAsk) return;

    book.ready = false;
    this.desyncs++;
    logDebug(`[clob-market] book ${book.tokenId.slice(0, 10)}… missing top level (#${this.desyncs})`);
    this.scheduleResync();
  }

  /** Resubscribe if some book is still unready after a grace period (a snapshot usually arrives first). */
  private scheduleResync(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      this.resyncIfStale();
    }, 2_000);
  }

  private resyncIfStale(): void {
    const now = Date.now();
    const stale = [...this.books.values()].some((b) => !b.ready);
    if (!stale || !this.socket.isOpen) return;
    if (now - this.socket.connectedAt < 5_000 || now - this.lastResyncAt < 15_000) return;
    this.lastResyncAt = now;
    logWarn("[clob-market] order book out of sync; resubscribing");
    this.socket.restart();
  }
}
