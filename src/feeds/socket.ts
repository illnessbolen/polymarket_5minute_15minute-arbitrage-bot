/**
 * WebSocket with heartbeat, stale-connection detection and exponential
 * reconnect backoff. Polymarket sockets expect a text "PING" heartbeat and
 * answer "PONG".
 */

import WebSocket from "ws";
import { logDebug, logInfo, logWarn } from "../utils/logger";

export interface SocketOptions {
  name: string;
  url: string;
  /** Called after every (re)connect; send subscriptions here. */
  onOpen: (send: (payload: unknown) => void) => void;
  onMessage: (text: string) => void;
  onClose?: () => void;
  pingIntervalMs?: number;
  /** Reconnect if nothing (not even PONG) arrives for this long. */
  staleAfterMs?: number;
}

export class ManagedSocket {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private backoffMs = 1000;
  private stopped = true;
  /** Local time of the last successful open. */
  connectedAt = 0;

  constructor(private readonly opts: SocketOptions) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on("error", () => undefined);
      this.ws.terminate();
      this.ws = null;
    }
  }

  /** Drop the current connection and reconnect immediately (e.g. to resubscribe). */
  restart(): void {
    if (this.stopped) return;
    this.stop();
    this.stopped = false;
    this.backoffMs = 1000;
    this.connect();
  }

  send(payload: unknown): void {
    if (!this.isOpen || !this.ws) return;
    this.ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on("open", () => {
      this.connectedAt = Date.now();
      this.lastMessageAt = Date.now();
      this.backoffMs = 1000;
      logInfo(`[${this.opts.name}] connected`);
      this.startHeartbeat();
      this.opts.onOpen((p) => this.send(p));
    });

    ws.on("message", (data) => {
      this.lastMessageAt = Date.now();
      const text = data.toString();
      if (text === "PONG" || text === "pong" || text.length === 0) return;
      this.opts.onMessage(text);
    });

    ws.on("error", (err) => {
      logWarn(`[${this.opts.name}] socket error: ${err.message}`);
    });

    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.clearTimers();
      this.ws = null;
      this.opts.onClose?.();
      if (this.stopped) return;
      logWarn(`[${this.opts.name}] closed (code ${code}); reconnecting in ${this.backoffMs}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  private startHeartbeat(): void {
    const interval = this.opts.pingIntervalMs ?? 10_000;
    const staleAfter = this.opts.staleAfterMs ?? 30_000;
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > staleAfter) {
        logWarn(`[${this.opts.name}] no data for ${staleAfter}ms, reconnecting`);
        this.ws?.terminate();
        return;
      }
      this.send("PING");
      logDebug(`[${this.opts.name}] PING`);
    }, interval);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }
}
