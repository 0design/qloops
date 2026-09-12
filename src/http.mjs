import { setTimeout as delay } from "node:timers/promises";

const RETRY_DELAYS_MS = [1_500, 4_000];
const MAX_TIMER_MS = 2_147_483_647;

function isRetryableNetwork(err) {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  return name === "TimeoutError" || name === "AbortError"
    || /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket|network|unreachable/i.test(message);
}

function validatePolicy(timeoutMs, retries, delaysMs) {
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
    throw new RangeError("retries must be an integer between 0 and 10");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError("timeoutMs must be a positive, supported timer duration");
  }
  if (!Array.isArray(delaysMs) || delaysMs.length === 0
    || delaysMs.some(ms => !Number.isInteger(ms) || ms < 0 || ms > MAX_TIMER_MS)) {
    throw new RangeError("delaysMs must contain non-negative, supported timer durations");
  }
}

/** Returns headers; callers must consume the final body. Retries replay the
 * request, so side-effecting callers must supply their own idempotency policy. */
export async function fetchWithRetry(url, init = {}, {
  timeoutMs = 30_000, retries = 2, delaysMs = RETRY_DELAYS_MS,
} = {}) {
  validatePolicy(timeoutMs, retries, delaysMs);
  const callerSignal = init.signal;
  for (let attempt = 0; attempt <= retries; attempt++) {
    callerSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      // A caller's cancellation is final, even if its reason resembles a timeout.
      callerSignal?.throwIfAborted();
      if (!isRetryableNetwork(error) || attempt === retries) throw error;
    }
    if (response) {
      const retryable = response.status === 429
        || (response.status >= 500 && response.status <= 599);
      if (!retryable || attempt === retries) return response;
      // Release the discarded body before the next connection/attempt.
      await response.body?.cancel().catch(() => {});
    }
    await delay(delaysMs[Math.min(attempt, delaysMs.length - 1)], undefined, {
      signal: callerSignal,
    });
  }
}
