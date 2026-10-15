import { describe, expect, it, vi } from "vitest";

import { backoffMs, createRetryingFetch, retryAfterMs } from "../src/retry.js";

const URL_ = "https://api.izap.ai/api/v1/whatsapp_templates";

type Step = Response | Error | "hang";

function scripted(...steps: Step[]) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const step = steps.shift();
    if (step === undefined) throw new Error("Unexpected request");
    if (step === "hang") {
      return new Promise<Response>((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        request.signal.addEventListener("abort", () =>
          reject(request.signal.reason),
        );
      });
    }
    if (step instanceof Error) throw step;
    return step;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

function setup(
  steps: Step[],
  options: { maxRetries?: number; timeoutMs?: number } = {},
) {
  const { fetch, requests } = scripted(...steps);
  const sleeps: number[] = [];
  const retrying = createRetryingFetch({
    fetch,
    maxRetries: options.maxRetries ?? 2,
    timeoutMs: options.timeoutMs ?? 30_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  return { retrying, requests, sleeps };
}

const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(null, { status: code, headers });

describe("createRetryingFetch", () => {
  it("backs off exponentially and returns the last retryable response", async () => {
    const { retrying, requests, sleeps } = setup([
      status(503),
      status(502),
      status(504),
    ]);

    const response = await retrying(URL_);

    expect(response.status).toBe(504);
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("honours Retry-After in seconds over backoff", async () => {
    const { retrying, sleeps } = setup([
      status(429, { "retry-after": "2" }),
      status(200),
    ]);

    expect((await retrying(URL_)).status).toBe(200);
    expect(sleeps).toEqual([2000]);
  });

  it("returns immediately when Retry-After is longer than a minute", async () => {
    const { retrying, requests } = setup([
      status(429, { "retry-after": "3600" }),
    ]);

    expect((await retrying(URL_)).status).toBe(429);
    expect(requests).toHaveLength(1);
  });

  it("does not retry other statuses", async () => {
    const { retrying, requests } = setup([status(500)]);

    expect((await retrying(URL_)).status).toBe(500);
    expect(requests).toHaveLength(1);
  });

  it.each(["POST", "PATCH"])("never retries %s", async (method) => {
    const { retrying, requests } = setup([status(503)]);

    expect((await retrying(URL_, { method, body: "{}" })).status).toBe(503);
    expect(requests).toHaveLength(1);
  });

  it("re-sends the body when retrying a PUT", async () => {
    const { retrying, requests } = setup([status(503), status(200)]);

    await retrying(URL_, { method: "PUT", body: '{"mode":"allow"}' });

    expect(requests).toHaveLength(2);
    expect(await requests[0]!.text()).toBe('{"mode":"allow"}');
    expect(await requests[1]!.text()).toBe('{"mode":"allow"}');
  });

  it("retries a connection failure on an idempotent request only", async () => {
    const get = setup([new TypeError("fetch failed"), status(200)]);
    expect((await get.retrying(URL_)).status).toBe(200);
    expect(get.requests).toHaveLength(2);

    const post = setup([new TypeError("fetch failed")]);
    await expect(post.retrying(URL_, { method: "POST" })).rejects.toThrow(
      "fetch failed",
    );
    expect(post.requests).toHaveLength(1);
  });

  it("times out each attempt and retries the timeout", async () => {
    const { retrying, requests } = setup(["hang", "hang"], {
      maxRetries: 1,
      timeoutMs: 10,
    });

    await expect(retrying(URL_)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(requests).toHaveLength(2);
  });

  it("does not retry after the caller aborts", async () => {
    const { retrying, requests } = setup(["hang", status(200)]);
    const controller = new AbortController();

    const pending = retrying(URL_, { signal: controller.signal });
    controller.abort(new Error("caller gave up"));

    await expect(pending).rejects.toThrow("caller gave up");
    expect(requests).toHaveLength(1);
  });

  it("makes a single attempt when maxRetries is 0", async () => {
    const { retrying, requests } = setup([status(503)], { maxRetries: 0 });

    expect((await retrying(URL_)).status).toBe(503);
    expect(requests).toHaveLength(1);
  });
});

describe("retryAfterMs", () => {
  it("parses seconds and HTTP dates", () => {
    const now = Date.parse("2026-09-14T12:00:00Z");

    expect(retryAfterMs("1.5", now)).toBe(1500);
    expect(retryAfterMs("Mon, 14 Sep 2026 12:00:03 GMT", now)).toBe(3000);
    expect(retryAfterMs("Mon, 14 Sep 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });
});

describe("backoffMs", () => {
  it("applies jitter and caps the delay", () => {
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(0, () => 1)).toBe(375);
    expect(backoffMs(10, () => 0)).toBe(8000);
  });
});
