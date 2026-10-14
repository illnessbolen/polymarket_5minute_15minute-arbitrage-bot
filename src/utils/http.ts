/**
 * Small JSON-over-HTTP helper with timeout and retries.
 */

import { retry } from "./retry";

const USER_AGENT = "polymarket-updown-arb/2.0";

export async function fetchJson<T>(url: string, timeoutMs = 8000, attempts = 3): Promise<T> {
  return retry(
    async () => {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      return (await res.json()) as T;
    },
    { maxAttempts: attempts, delaysMs: [300, 1000, 2000] },
  );
}
