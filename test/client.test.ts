import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createClient, IzapApiError, VERSION } from "../src/index.js";

const TOKEN = "izap_pat_test_token";
const BUSINESS_ID = "8f0b9e2a-0000-4000-8000-000000000001";
const CHAT_ID = "b91d4a5e-0000-4000-8000-000000000003";
const TEMPLATES = { templates: [], total_count: 0 };

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(...responses: Array<Response | Error>) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

async function rejection(promise: Promise<unknown>): Promise<IzapApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(IzapApiError);
  return error as IzapApiError;
}

describe("createClient", () => {
  it("sends the personal access token as a bearer token to the default base URL", async () => {
    const { fetch, requests } = mockFetch(json(200, TEMPLATES));
    const izap = createClient({ token: TOKEN, fetch });

    const { data } = await izap.listWhatsAppTemplates();

    expect(data).toEqual(TEMPLATES);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe(
      "https://api.izap.ai/api/v1/whatsapp_templates",
    );
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]!.headers.get("user-agent")).toBe(
      `izap-sdk-typescript/${VERSION}`,
    );
  });

  it("sends business-id only when businessId is set", async () => {
    const withBusiness = mockFetch(json(200, TEMPLATES));
    await createClient({
      token: TOKEN,
      businessId: BUSINESS_ID,
      fetch: withBusiness.fetch,
    }).listWhatsAppTemplates();
    expect(withBusiness.requests[0]!.headers.get("business-id")).toBe(
      BUSINESS_ID,
    );

    const without = mockFetch(json(200, TEMPLATES));
    await createClient({
      token: TOKEN,
      fetch: without.fetch,
    }).listWhatsAppTemplates();
    expect(without.requests[0]!.headers.has("business-id")).toBe(false);
  });

  it("lets a single call override the default business", async () => {
    const other = "11111111-0000-4000-8000-000000000000";
    const { fetch, requests } = mockFetch(json(200, TEMPLATES));
    const izap = createClient({ token: TOKEN, businessId: BUSINESS_ID, fetch });

    await izap.listWhatsAppTemplates({ headers: { "business-id": other } });

    expect(requests[0]!.headers.get("business-id")).toBe(other);
  });

  it("builds path, query and JSON body from the operation options", async () => {
    const sent = { user_message: { id: "m1" } };
    const { fetch, requests } = mockFetch(
      json(200, sent),
      json(200, TEMPLATES),
    );
    const izap = createClient({
      token: TOKEN,
      baseUrl: "https://api-staging.izap.ai/",
      fetch,
    });

    const { data } = await izap.sendChatMessage({
      path: { chat_id: CHAT_ID },
      body: { content: "Olá!" },
    });
    await izap.listWhatsAppTemplates({ query: { status: "approved" } });

    expect(data).toEqual(sent);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe(
      `https://api-staging.izap.ai/api/v1/chats/${CHAT_ID}/messages`,
    );
    expect(requests[0]!.headers.get("content-type")).toBe("application/json");
    expect(await requests[0]!.json()).toEqual({ content: "Olá!" });
    expect(requests[1]!.url).toBe(
      "https://api-staging.izap.ai/api/v1/whatsapp_templates?status=approved",
    );
  });

  it("scopes by the business-id header instead of an undeclared path form", async () => {
    const { fetch, requests } = mockFetch(json(200, {}));
    const izap = createClient({ token: TOKEN, businessId: BUSINESS_ID, fetch });

    await izap.getCurrentBusinessHours();

    expect(requests[0]!.url).toBe(
      "https://api.izap.ai/api/v1/businesses/hours",
    );
    expect(requests[0]!.headers.get("business-id")).toBe(BUSINESS_ID);
    expect(
      (izap as unknown as Record<string, unknown>).getBusiness,
    ).toBeUndefined();
  });

  it("rejects a missing token and invalid retry/timeout settings", () => {
    expect(() => createClient({ token: "" })).toThrow(TypeError);
    expect(() => createClient({ token: TOKEN, maxRetries: -1 })).toThrow(
      TypeError,
    );
    expect(() => createClient({ token: TOKEN, timeoutMs: 0 })).toThrow(
      TypeError,
    );
  });
});

describe("IzapApiError", () => {
  const call = (response: Response) =>
    createClient({
      token: TOKEN,
      maxRetries: 0,
      fetch: mockFetch(response).fetch,
    }).listWhatsAppTemplates();

  it("maps a string detail", async () => {
    const error = await rejection(
      call(json(404, { detail: "Chat not found" })),
    );

    expect(error.status).toBe(404);
    expect(error.detail).toBe("Chat not found");
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("iZap API error 404: Chat not found");
    expect(error.request).toBe(
      "GET https://api.izap.ai/api/v1/whatsapp_templates",
    );
  });

  it("maps a structured detail with a code", async () => {
    const detail = {
      code: "plan_limit_event_webhooks",
      message: "Your plan does not include event webhooks.",
    };
    const error = await rejection(call(json(403, { detail })));

    expect(error.status).toBe(403);
    expect(error.code).toBe("plan_limit_event_webhooks");
    expect(error.detail).toEqual(detail);
    expect(error.message).toBe(
      "iZap API error 403 (plan_limit_event_webhooks): Your plan does not include event webhooks.",
    );
  });

  it("maps a validation error list", async () => {
    const detail = [
      { loc: ["body", "content"], msg: "Field required", type: "missing" },
    ];
    const error = await rejection(call(json(422, { detail })));

    expect(error.detail).toEqual(detail);
    expect(error.message).toBe(
      "iZap API error 422: body.content: Field required",
    );
  });

  it("reads a top-level code from a 5xx body", async () => {
    const error = await rejection(
      call(
        json(500, { detail: "Internal Server Error", code: "internal_error" }),
      ),
    );

    expect(error.status).toBe(500);
    expect(error.code).toBe("internal_error");
  });

  it("keeps a non-JSON body as text and exposes response headers", async () => {
    const error = await rejection(
      call(
        new Response("upstream unavailable", {
          status: 502,
          headers: { "x-request-id": "req_1" },
        }),
      ),
    );

    expect(error.body).toBe("upstream unavailable");
    expect(error.detail).toBeUndefined();
    expect(error.headers.get("x-request-id")).toBe("req_1");
  });
});

describe("retries through createClient", () => {
  it("retries an idempotent request on 503 and honours Retry-After", async () => {
    const { fetch, requests } = mockFetch(
      json(503, { detail: "busy" }, { "retry-after": "0" }),
      json(200, TEMPLATES),
    );
    const { data } = await createClient({
      token: TOKEN,
      fetch,
    }).listWhatsAppTemplates();

    expect(data).toEqual(TEMPLATES);
    expect(requests).toHaveLength(2);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const { fetch, requests } = mockFetch(
      json(429, { detail: "slow down" }, { "retry-after": "0" }),
      json(429, { detail: "slow down" }, { "retry-after": "0" }),
      json(429, { detail: "slow down" }, { "retry-after": "0" }),
    );
    const error = await rejection(
      createClient({
        token: TOKEN,
        fetch,
        maxRetries: 2,
      }).listWhatsAppTemplates(),
    );

    expect(error.status).toBe(429);
    expect(requests).toHaveLength(3);
  });

  it("never retries a POST", async () => {
    const { fetch, requests } = mockFetch(
      json(503, { detail: "busy" }, { "retry-after": "0" }),
    );
    const error = await rejection(
      createClient({ token: TOKEN, fetch }).sendChatMessage({
        path: { chat_id: CHAT_ID },
        body: { content: "hi" },
      }),
    );

    expect(error.status).toBe(503);
    expect(requests).toHaveLength(1);
  });
});

it("VERSION matches package.json", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
