const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const BASE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 8_000;
// A longer Retry-After is a real outage or quota window; hand the response back instead of stalling.
const MAX_RETRY_AFTER_MS = 60_000;

export interface RetryingFetchOptions {
  fetch: typeof fetch;
  maxRetries: number;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Wraps `fetch` with a per-attempt timeout and retries.
 *
 * Only idempotent methods are retried, and only on 429/502/503/504, connection
 * failures and timeouts. `Retry-After` (seconds or an HTTP date) takes precedence
 * over exponential backoff with jitter.
 */
export function createRetryingFetch(
  options: RetryingFetchOptions,
): typeof fetch {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  return async (input, init) => {
    const request = new Request(input, init);
    const attempts = IDEMPOTENT_METHODS.has(request.method.toUpperCase())
      ? options.maxRetries + 1
      : 1;

    for (let attempt = 0; ; attempt++) {
      const isLastAttempt = attempt >= attempts - 1;
      let response: Response;
      try {
        response = await sendOnce(request, options.fetch, options.timeoutMs);
      } catch (error) {
        if (isLastAttempt || request.signal.aborted || !isTransient(error)) {
          throw error;
        }
        await sleep(backoffMs(attempt, random));
        continue;
      }

      if (isLastAttempt || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      const retryAfter = retryAfterMs(response.headers.get("retry-after"));
      if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryAfter ?? backoffMs(attempt, random));
    }
  };
}

async function sendOnce(
  request: Request,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) forwardAbort();
  else request.signal.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `Request timed out after ${timeoutMs}ms`,
          "TimeoutError",
        ),
      ),
    timeoutMs,
  );
  try {
    return await fetchImpl(
      new Request(request.clone(), { signal: controller.signal }),
    );
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", forwardAbort);
  }
}

function isTransient(error: unknown): boolean {
  // fetch reports connection failures as TypeError; timeouts come from sendOnce.
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling * (1 - 0.25 * random()));
}

export function retryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const value = header.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
