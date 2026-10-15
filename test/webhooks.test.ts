import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  webhooks,
  WEBHOOK_HEADERS,
  WebhookVerificationError,
  type WebhookVerificationErrorCode,
} from "../src/index.js";

// Signed by the backend's own webhook signer, so these tests pin SDK and server to one contract.
const vector = JSON.parse(
  readFileSync(
    new URL("./fixtures/webhook-vectors.json", import.meta.url),
    "utf8",
  ),
) as {
  secret: string;
  timestamp: string;
  id: string;
  event: string;
  body: string;
  signature: string;
  signatureV2: string;
};
const deliveredAt = Number(vector.timestamp);

function headers(overrides: Record<string, string | undefined> = {}) {
  return {
    [WEBHOOK_HEADERS.id]: vector.id,
    [WEBHOOK_HEADERS.event]: vector.event,
    [WEBHOOK_HEADERS.timestamp]: vector.timestamp,
    [WEBHOOK_HEADERS.signature]: vector.signature,
    ...overrides,
  };
}

const v1Only = { allowV1: true as const };

/** Headers as the backend now actually sends them: both v1 and v2. */
function headersWithV2(overrides: Record<string, string | undefined> = {}) {
  return headers({ [WEBHOOK_HEADERS.v2]: vector.signatureV2, ...overrides });
}

function failure(run: () => unknown): WebhookVerificationErrorCode {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookVerificationError);
    return (error as WebhookVerificationError).code;
  }
  throw new Error("Expected verification to fail");
}

function setNow(unixSeconds: number) {
  vi.setSystemTime(unixSeconds * 1000);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow(deliveredAt + 5);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("webhooks.verify", () => {
  it("accepts a delivery signed by the iZap backend and returns the parsed event", () => {
    const event = webhooks.verify({
      payload: vector.body,
      headers: headersWithV2(),
      secret: vector.secret,
    });

    expect(event.id).toBe(vector.id);
    expect(event.event).toBe("message.received");
    expect(event.timestamp).toBe(deliveredAt);
    expect(event.data.message.text).toBe(
      "Olá! Qual o horário de funcionamento? 🕘",
    );
    expect(event.data.business_id).toBe("8f0b9e2a-0000-4000-8000-000000000001");
  });

  it("accepts a Buffer body, a Headers instance and Node-style header objects", () => {
    const secret = vector.secret;
    const payload = Buffer.from(vector.body, "utf8");

    expect(
      webhooks.verify({
        payload,
        headers: new Headers(headersWithV2()),
        secret,
      }).id,
    ).toBe(vector.id);
    expect(
      webhooks.verify({
        payload,
        secret,
        headers: {
          "Izap-Webhook-Id": vector.id,
          "izap-webhook-timestamp": [vector.timestamp],
          "izap-webhook-signature": vector.signature,
          "izap-webhook-signature-v2": vector.signatureV2,
        },
      }).event,
    ).toBe("message.received");
  });

  it("rejects a tampered body", () => {
    const tampered = vector.body.replace("Olá", "Ola");

    expect(
      failure(() =>
        webhooks.verify({
          payload: tampered,
          headers: headers(),
          secret: vector.secret,
          ...v1Only,
        }),
      ),
    ).toBe("invalid_signature");
  });

  it("rejects a bad signature or the wrong secret", () => {
    const bad = `v1=${"0".repeat(64)}`;

    expect(
      failure(() =>
        webhooks.verify({
          payload: vector.body,
          headers: headers({ [WEBHOOK_HEADERS.signature]: bad }),
          secret: vector.secret,
          ...v1Only,
        }),
      ),
    ).toBe("invalid_signature");
    expect(
      failure(() =>
        webhooks.verify({
          payload: vector.body,
          headers: headers(),
          secret: "izap_whsec_someone_else",
          ...v1Only,
        }),
      ),
    ).toBe("invalid_signature");
    expect(
      failure(() =>
        webhooks.verify({
          payload: vector.body,
          headers: headers({
            [WEBHOOK_HEADERS.signature]: vector.signature.slice(3),
          }),
          secret: vector.secret,
          ...v1Only,
        }),
      ),
    ).toBe("invalid_signature");
  });

  it("accepts a v1 signature listed alongside a future scheme", () => {
    const signature = `v2=${"a".repeat(64)}, ${vector.signature}`;

    expect(
      webhooks.verify({
        payload: vector.body,
        headers: headers({ [WEBHOOK_HEADERS.signature]: signature }),
        secret: vector.secret,
        ...v1Only,
      }).id,
    ).toBe(vector.id);
  });

  it("rejects stale and future timestamps outside the tolerance", () => {
    const verify = (toleranceSec?: number) => () =>
      webhooks.verify({
        payload: vector.body,
        headers: headersWithV2(),
        secret: vector.secret,
        toleranceSec,
      });

    setNow(deliveredAt + 301);
    expect(failure(verify())).toBe("timestamp_out_of_tolerance");
    expect(verify(600)().id).toBe(vector.id);

    setNow(deliveredAt - 301);
    expect(failure(verify())).toBe("timestamp_out_of_tolerance");
  });

  it("rejects missing headers and a malformed timestamp", () => {
    const run = (overrides: Record<string, string | undefined>) => () =>
      webhooks.verify({
        payload: vector.body,
        headers: headersWithV2(overrides),
        secret: vector.secret,
      });

    expect(failure(run({ [WEBHOOK_HEADERS.v2]: undefined }))).toBe(
      "missing_header",
    );
    expect(failure(run({ [WEBHOOK_HEADERS.id]: "" }))).toBe("missing_header");
    expect(failure(run({ [WEBHOOK_HEADERS.timestamp]: "1789207200.5" }))).toBe(
      "invalid_timestamp",
    );
  });

  it("rejects a signed body that is not JSON", () => {
    const payload = "not json";
    const signature = webhooks.sign({
      payload,
      secret: vector.secret,
      timestamp: deliveredAt,
    });

    expect(
      failure(() =>
        webhooks.verify({
          payload,
          headers: headers({ [WEBHOOK_HEADERS.signature]: signature }),
          secret: vector.secret,
          ...v1Only,
        }),
      ),
    ).toBe("invalid_payload");
  });

  it("refuses a parsed body or an empty secret", () => {
    expect(() =>
      webhooks.verify({
        payload: JSON.parse(vector.body) as unknown as string,
        headers: headers(),
        secret: vector.secret,
      }),
    ).toThrow(TypeError);
    expect(() =>
      webhooks.verify({ payload: vector.body, headers: headers(), secret: "" }),
    ).toThrow(TypeError);
  });

  it("verifies via v2 when the header is present, and returns the parsed event", () => {
    const event = webhooks.verify({
      payload: vector.body,
      headers: headersWithV2(),
      secret: vector.secret,
    });

    expect(event.id).toBe(vector.id);
    expect(event.event).toBe("message.received");
    expect(event.timestamp).toBe(deliveredAt);
  });

  it("rejects a v2 signature tampered via the id, timestamp, or body", () => {
    expect(
      failure(() =>
        webhooks.verify({
          payload: vector.body,
          headers: headersWithV2({ [WEBHOOK_HEADERS.id]: "not-the-real-id" }),
          secret: vector.secret,
        }),
      ),
    ).toBe("invalid_signature");

    expect(
      failure(() =>
        webhooks.verify({
          payload: vector.body,
          headers: headersWithV2({
            [WEBHOOK_HEADERS.timestamp]: String(deliveredAt + 1),
          }),
          secret: vector.secret,
        }),
      ),
    ).toBe("invalid_signature");

    const tampered = vector.body.replace("Olá", "Ola");
    expect(
      failure(() =>
        webhooks.verify({
          payload: tampered,
          headers: headersWithV2(),
          secret: vector.secret,
        }),
      ),
    ).toBe("invalid_signature");
  });

  it("rejects a missing v2 header by default so a replay cannot strip it", () => {
    expect(
      failure(() =>
        webhooks.verify({
          payload: vector.body,
          headers: headers(),
          secret: vector.secret,
        }),
      ),
    ).toBe("missing_header");
  });

  it("accepts a v1-only delivery when allowV1 is set", () => {
    const event = webhooks.verify({
      payload: vector.body,
      headers: headers(),
      secret: vector.secret,
      ...v1Only,
    });

    expect(event.id).toBe(vector.id);
  });

  it("does not fall back to a passing v1 signature when v2 is present but tampered", () => {
    const tamperedV2 = `v2=${"0".repeat(64)}`;

    expect(
      failure(() =>
        webhooks.verify({
          payload: vector.body,
          // v1 header is untouched and would verify on its own.
          headers: headersWithV2({ [WEBHOOK_HEADERS.v2]: tamperedV2 }),
          secret: vector.secret,
        }),
      ),
    ).toBe("invalid_signature");
  });
});

describe("webhooks.sign", () => {
  it("produces the same signature as the iZap backend", () => {
    expect(
      webhooks.sign({
        payload: vector.body,
        secret: vector.secret,
        timestamp: deliveredAt,
      }),
    ).toBe(vector.signature);
  });
});

describe("webhooks.signV2", () => {
  it("produces the same v2 signature as the iZap backend", () => {
    expect(
      webhooks.signV2({
        payload: vector.body,
        secret: vector.secret,
        id: vector.id,
        timestamp: deliveredAt,
      }),
    ).toBe(vector.signatureV2);
  });

  it("round-trips through webhooks.verify with a fresh id and secret", () => {
    const secret = "izap_whsec_local_testing_secret";
    const id = "9f1e6a2b-0000-4000-8000-0000000000ff";
    const timestamp = deliveredAt;
    const payload = JSON.stringify({ event: "message.received", ok: true });

    const signature = webhooks.signV2({ payload, secret, id, timestamp });
    const event = webhooks.verify({
      payload,
      secret,
      headers: {
        [WEBHOOK_HEADERS.id]: id,
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.v2]: signature,
      },
    });

    expect(event.id).toBe(id);
  });
});
