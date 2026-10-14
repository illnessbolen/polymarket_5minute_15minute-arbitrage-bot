/**
 * Gamma API: market discovery and resolution data for recurring up/down events
 * (slug pattern `<asset>-updown-<5m|15m>-<window start unix seconds>`).
 */

import type { FeeSchedule, Horizon, MarketInfo } from "../types";
import { HORIZON_SECONDS, eventSlug } from "../core/windows";
import { fetchJson } from "../utils/http";
import { logWarn } from "../utils/logger";

const GAMMA_URL = "https://gamma-api.polymarket.com";

interface GammaMarket {
  id: string;
  conditionId: string;
  question?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  eventStartTime?: string;
  endDate?: string;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  negRisk?: boolean;
  acceptingOrders?: boolean;
  closed?: boolean;
  umaResolutionStatus?: string;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number; exponent?: number; takerOnly?: boolean };
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  startTime?: string;
  endDate?: string;
  closed?: boolean;
  eventMetadata?: { priceToBeat?: number; finalPrice?: number };
  markets?: GammaMarket[];
}

export interface Resolution {
  /** Settled winner, or null while the market is unresolved. */
  winner: "UP" | "DOWN" | null;
  priceToBeat: number | null;
  finalPrice: number | null;
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toUnix(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

export class GammaClient {
  constructor(private readonly defaultFee: FeeSchedule) {}

  async fetchEvent(slug: string): Promise<GammaEvent | null> {
    const events = await fetchJson<GammaEvent[]>(`${GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`);
    return Array.isArray(events) && events.length > 0 ? events[0] : null;
  }

  async fetchMarket(asset: string, horizon: Horizon, startSec: number): Promise<MarketInfo | null> {
    const slug = eventSlug(asset, horizon, startSec);
    const event = await this.fetchEvent(slug);
    if (!event) return null;
    return this.parseMarket(asset, horizon, startSec, event);
  }

  parseMarket(asset: string, horizon: Horizon, startSec: number, event: GammaEvent): MarketInfo | null {
    const m = event.markets?.[0];
    if (!m) return null;

    const outcomes = parseJsonArray(m.outcomes).map((o) => o.toLowerCase());
    const tokens = parseJsonArray(m.clobTokenIds);
    const upIdx = outcomes.indexOf("up");
    const downIdx = outcomes.indexOf("down");
    if (upIdx < 0 || downIdx < 0 || !tokens[upIdx] || !tokens[downIdx]) {
      logWarn(`Gamma: unexpected outcomes/tokens for ${event.slug}: ${m.outcomes} ${m.clobTokenIds}`);
      return null;
    }

    const startTime = toUnix(m.eventStartTime ?? event.startTime) ?? startSec;
    const endTime = toUnix(m.endDate ?? event.endDate) ?? startSec + HORIZON_SECONDS[horizon];
    if (startTime !== startSec || endTime !== startSec + HORIZON_SECONDS[horizon]) {
      logWarn(`Gamma: ${event.slug} has unexpected window ${startTime}..${endTime}`);
      return null;
    }

    return {
      asset,
      horizon,
      slug: event.slug,
      eventId: event.id,
      conditionId: m.conditionId,
      title: event.title,
      startTime,
      endTime,
      upTokenId: tokens[upIdx],
      downTokenId: tokens[downIdx],
      tickSize: Number(m.orderPriceMinTickSize) || 0.01,
      minOrderSize: Number(m.orderMinSize) || 5,
      fee: this.parseFee(m),
      negRisk: Boolean(m.negRisk),
      acceptingOrders: m.acceptingOrders !== false,
      closed: Boolean(m.closed),
    };
  }

  private parseFee(m: GammaMarket): FeeSchedule {
    if (m.feesEnabled === false) return { rate: 0, exponent: 1, takerOnly: true };
    const s = m.feeSchedule;
    if (s && typeof s.rate === "number") {
      return { rate: s.rate, exponent: typeof s.exponent === "number" ? s.exponent : 1, takerOnly: s.takerOnly !== false };
    }
    return this.defaultFee;
  }

  async fetchResolution(slug: string): Promise<Resolution | null> {
    const event = await this.fetchEvent(slug);
    if (!event) return null;
    const m = event.markets?.[0];
    const meta = event.eventMetadata ?? {};
    const outcomes = parseJsonArray(m?.outcomes).map((o) => o.toLowerCase());
    const prices = parseJsonArray(m?.outcomePrices).map(Number);
    let winner: Resolution["winner"] = null;
    if (m?.closed && prices.length === outcomes.length) {
      const idx = prices.findIndex((p) => p === 1);
      if (idx >= 0 && (outcomes[idx] === "up" || outcomes[idx] === "down")) {
        winner = outcomes[idx] === "up" ? "UP" : "DOWN";
      }
    }
    return {
      winner,
      priceToBeat: typeof meta.priceToBeat === "number" ? meta.priceToBeat : null,
      finalPrice: typeof meta.finalPrice === "number" ? meta.finalPrice : null,
    };
  }
}
