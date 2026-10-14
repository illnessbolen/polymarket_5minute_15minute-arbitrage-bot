/**
 * Chainlink 60-second TWAP reference prices from Polymarket's real-time data
 * socket (topic `crypto_prices_twap_sixty`, no authentication).
 *
 * Since Aug 2026 up/down markets settle on this feed: the "price to beat" of a
 * window is the TWAP value stamped at the window start and the final price is
 * the value stamped at the window end. The 5m and 15m markets ending at the
 * same instant therefore settle on the same number.
 *
 * Payload example:
 *   {"topic":"crypto_prices_twap_sixty","type":"update",
 *    "payload":{"symbol":"btc/usd","timestamp":1791999600000,"value":81691.21,"window_s":60}}
 */

import { EventEmitter } from "events";
import { ManagedSocket } from "./socket";
import { logDebug } from "../utils/logger";

const RTDS_URL = "wss://ws-live-data.polymarket.com";
const TOPIC = "crypto_prices_twap_sixty";
const RETAIN_SECONDS = 3 * 3600;

interface TwapMessage {
  topic?: string;
  type?: string;
  payload?: { symbol?: string; timestamp?: number; value?: number };
}

export const assetSymbol = (asset: string): string => `${asset.toLowerCase()}/usd`;

export declare interface ChainlinkTwapFeed {
  on(event: "tick", listener: (symbol: string, unixSec: number, value: number) => void): this;
}

export class ChainlinkTwapFeed extends EventEmitter {
  private readonly series = new Map<string, Map<number, number>>();
  private readonly latest = new Map<string, { sec: number; value: number; receivedAt: number }>();
  private readonly socket: ManagedSocket;

  constructor(private readonly symbols: Set<string>) {
    super();
    this.socket = new ManagedSocket({
      name: "chainlink-twap",
      url: RTDS_URL,
      pingIntervalMs: 5_000,
      staleAfterMs: 20_000,
      onOpen: (send) => send({ action: "subscribe", subscriptions: [{ topic: TOPIC, type: "update" }] }),
      onMessage: (text) => this.handle(text),
    });
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
  }

  get connected(): boolean {
    return this.socket.isOpen;
  }

  /** TWAP value stamped exactly at `unixSec`, if it was received. */
  valueAt(symbol: string, unixSec: number): number | null {
    return this.series.get(symbol)?.get(unixSec) ?? null;
  }

  latestValue(symbol: string): { sec: number; value: number; receivedAt: number } | null {
    return this.latest.get(symbol) ?? null;
  }

  /** Feed a value manually (used by tests and backfills). */
  record(symbol: string, unixSec: number, value: number): void {
    let s = this.series.get(symbol);
    if (!s) {
      s = new Map();
      this.series.set(symbol, s);
    }
    s.set(unixSec, value);
    const prev = this.latest.get(symbol);
    if (!prev || unixSec >= prev.sec) this.latest.set(symbol, { sec: unixSec, value, receivedAt: Date.now() });
    if (s.size > RETAIN_SECONDS + 600) {
      const cutoff = unixSec - RETAIN_SECONDS;
      for (const k of s.keys()) if (k < cutoff) s.delete(k);
    }
  }

  private handle(text: string): void {
    let msg: TwapMessage;
    try {
      msg = JSON.parse(text) as TwapMessage;
    } catch {
      logDebug(`[chainlink-twap] non-JSON message: ${text.slice(0, 120)}`);
      return;
    }
    if (msg.topic !== TOPIC || !msg.payload) return;
    const { symbol, timestamp, value } = msg.payload;
    if (!symbol || !this.symbols.has(symbol) || typeof timestamp !== "number" || typeof value !== "number") return;
    if (timestamp % 1000 !== 0) return;
    const sec = timestamp / 1000;
    this.record(symbol, sec, value);
    this.emit("tick", symbol, sec, value);
  }
}
