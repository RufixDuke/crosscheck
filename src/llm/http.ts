/**
 * Shared fetch helper for provider adapters (§5.9: raw `fetch`, no vendor
 * SDKs). Every adapter's network I/O funnels through here so the
 * timeout/retry/degradation policy (§11.6) is implemented exactly once:
 *
 *   - default timeout via AbortController (config `llm.timeoutMs`, §12.2)
 *   - one retry on 5xx or a network/timeout error
 *   - 4xx (auth/config errors) never retried — they are not transient
 *
 * This is the ONLY module in `src/llm` that calls `fetch`. Everything else
 * (redaction, prompt building, budgeting, consent) is pure and network-free
 * — see `tests/unit/llm/no-network.test.ts`.
 */

export interface FetchAttempt {
  ok: boolean;
  status?: number;
  body?: unknown;
  /** Present when ok === false — a short, human-readable failure reason. */
  reason?: string;
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status >= 500;
}

async function attemptOnce(url: string, init: RequestInit, timeoutMs: number): Promise<FetchAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        // best effort only
      }
      return { ok: false, status: res.status, reason: `http ${res.status}${detail ? `: ${detail}` : ""}` };
    }
    const data: unknown = await res.json();
    return { ok: true, status: res.status, body: data };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `network error: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** POST `url` with `init`, retrying once on 5xx/network/timeout (§11.6). */
export async function fetchJsonWithRetry(url: string, init: RequestInit, timeoutMs: number): Promise<FetchAttempt> {
  const first = await attemptOnce(url, init, timeoutMs);
  if (first.ok) return first;
  if (!isRetryableStatus(first.status)) return first;
  return attemptOnce(url, init, timeoutMs);
}
