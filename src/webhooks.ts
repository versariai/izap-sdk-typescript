import { createHmac, timingSafeEqual } from "node:crypto";

/** Header names iZap sends with every webhook delivery. */
export const WEBHOOK_HEADERS = {
  id: "izap-webhook-id",
  event: "izap-webhook-event",
  timestamp: "izap-webhook-timestamp",
  signature: "izap-webhook-signature",
  v2: "izap-webhook-signature-v2",
} as const;

export const DEFAULT_TOLERANCE_SEC = 300;

const SIGNATURE_VERSION = "v1";
const SIGNATURE_VERSION_V2 = "v2";

/** The `message.received` event body. */
export interface MessageReceivedEvent {
  event: "message.received";
  business_id: string;
  conversation_id: string | null;
  message: {
    id: string;
    chat_id: string | null;
    text: string;
    from: string | null;
    sender_type: string;
    /** ISO 8601 timestamp. */
    created_at: string;
  };
}

/** The `conversation.created` event body: a customer's first conversation with the business. */
export interface ConversationCreatedEvent {
  event: "conversation.created";
  business_id: string;
  conversation_id: string;
  chat: {
    id: string;
    chatbot_id: string | null;
    /** ISO 8601 timestamp. */
    created_at: string;
  };
  contact: {
    id: string | null;
    phone: string | null;
  };
}

/** The `message.status_updated` event body: a delivery verdict for a message the business sent. */
export interface MessageStatusUpdatedEvent {
  event: "message.status_updated";
  business_id: string;
  conversation_id: string | null;
  message: {
    id: string;
    chat_id: string | null;
    /** e.g. `sent`, `delivered`, `read`, `failed`. */
    status: string | null;
    error_code: number | null;
    error_reason: string | null;
    /** ISO 8601 timestamp. */
    updated_at: string;
  };
}

/** Every event in the iZap webhook catalog. */
export type IzapWebhookPayload =
  MessageReceivedEvent | ConversationCreatedEvent | MessageStatusUpdatedEvent;

/** A `Headers` instance or a plain object such as Node's `IncomingHttpHeaders`. */
export type WebhookHeaders =
  Headers | Record<string, string | string[] | undefined>;

export interface VerifyWebhookOptions {
  /** The raw request body, exactly as received. Not a re-serialized parse. */
  payload: string | Uint8Array;
  headers: WebhookHeaders;
  /** The endpoint's signing secret (`izap_whsec_…`). */
  secret: string;
  /** Maximum age, in seconds, of the delivery timestamp. Defaults to 300. */
  toleranceSec?: number;
  /**
   * Accept a v1-only delivery when `izap-webhook-signature-v2` is absent.
   * Off by default: a captured delivery always includes both headers, so
   * falling back whenever v2 is missing lets a replay strip v2 and reuse the
   * v1 HMAC under a new id. Set this only for senders that predate v2.
   */
  allowV1?: boolean;
}

export interface WebhookEvent<TPayload = IzapWebhookPayload> {
  /** Delivery id, stable across retries and resends: use it to dedupe. */
  id: string;
  /** Event type, e.g. `message.received`. */
  event: string;
  /** Unix timestamp (seconds) of this delivery attempt. */
  timestamp: number;
  /** The parsed event body. */
  data: TPayload;
}

export type WebhookVerificationErrorCode =
  | "missing_header"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance"
  | "invalid_signature"
  | "invalid_payload";

export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
  readonly code: WebhookVerificationErrorCode;

  constructor(code: WebhookVerificationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Verifies an iZap webhook delivery and returns the parsed event.
 *
 * By default, requires `izap-webhook-signature-v2`
 * (`v2=<hex HMAC-SHA256 of "{id}.{timestamp}.{raw_body}">`) — it covers the
 * delivery id, so a captured delivery cannot be replayed under a new id the way
 * it can under v1. Pass `allowV1: true` to accept a v1-only
 * `izap-webhook-signature` (`v1=<hex HMAC-SHA256 of "{timestamp}.{raw_body}">`)
 * when v2 is absent (senders from before v2 existed). Either check runs in
 * constant time. Both checks also reject timestamps outside `toleranceSec`.
 *
 * @throws {WebhookVerificationError} when the delivery is not authentic or is stale.
 */
export function verify<TPayload = IzapWebhookPayload>(
  options: VerifyWebhookOptions,
): WebhookEvent<TPayload> {
  const {
    secret,
    toleranceSec = DEFAULT_TOLERANCE_SEC,
    allowV1 = false,
  } = options;
  if (typeof secret !== "string" || secret === "") {
    throw new TypeError("webhooks.verify: `secret` is required.");
  }
  const body = rawBytes(options.payload);

  const id = readHeader(options.headers, WEBHOOK_HEADERS.id);
  const timestamp = readHeader(options.headers, WEBHOOK_HEADERS.timestamp);
  const signature = readHeader(options.headers, WEBHOOK_HEADERS.signature);
  const signatureV2 = readHeader(options.headers, WEBHOOK_HEADERS.v2);
  const missing = [
    [WEBHOOK_HEADERS.id, id],
    [WEBHOOK_HEADERS.timestamp, timestamp],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (!signatureV2 && !allowV1) {
    missing.push(WEBHOOK_HEADERS.v2);
  } else if (!signature && !signatureV2) {
    missing.push(`${WEBHOOK_HEADERS.signature} or ${WEBHOOK_HEADERS.v2}`);
  }
  if (
    !id ||
    !timestamp ||
    (!signatureV2 && !allowV1) ||
    (!signature && !signatureV2)
  ) {
    throw new WebhookVerificationError(
      "missing_header",
      `Missing webhook header(s): ${missing.join(", ")}.`,
    );
  }

  if (!/^\d+$/.test(timestamp)) {
    throw new WebhookVerificationError(
      "invalid_timestamp",
      `${WEBHOOK_HEADERS.timestamp} is not a Unix timestamp.`,
    );
  }
  const timestampSec = Number(timestamp);
  if (Math.abs(Date.now() / 1000 - timestampSec) > toleranceSec) {
    throw new WebhookVerificationError(
      "timestamp_out_of_tolerance",
      `${WEBHOOK_HEADERS.timestamp} is more than ${toleranceSec}s away from the current time.`,
    );
  }

  // v2 wins whenever it is present: it is the stronger check (it covers `id`,
  // closing v1's replay-under-a-new-id gap), and a delivery must not silently
  // fall back to a v1 signature that happens to still verify.
  const usingV2 = Boolean(signatureV2);
  const activeHeaderName = usingV2
    ? WEBHOOK_HEADERS.v2
    : WEBHOOK_HEADERS.signature;
  const activeSignature = (usingV2 ? signatureV2 : signature) as string;
  const activeVersion = usingV2 ? SIGNATURE_VERSION_V2 : SIGNATURE_VERSION;
  const expectedHex = usingV2
    ? computeSignatureV2(secret, id, timestamp, body)
    : computeSignature(secret, timestamp, body);

  if (!signatureMatches(activeSignature, activeVersion, expectedHex)) {
    throw new WebhookVerificationError(
      "invalid_signature",
      `${activeHeaderName} does not match the payload.`,
    );
  }

  let data: TPayload;
  try {
    data = JSON.parse(body.toString("utf8")) as TPayload;
  } catch {
    throw new WebhookVerificationError(
      "invalid_payload",
      "The signed payload is not valid JSON.",
    );
  }

  const event =
    readHeader(options.headers, WEBHOOK_HEADERS.event) ??
    (typeof data === "object" && data !== null && "event" in data
      ? String((data as { event: unknown }).event)
      : "");
  return { id, event, timestamp: timestampSec, data };
}

export interface SignWebhookOptions {
  payload: string | Uint8Array;
  secret: string;
  /** Unix timestamp in seconds. Defaults to now. */
  timestamp?: number;
}

/**
 * Produces the `izap-webhook-signature` (v1) value for a payload, e.g. to exercise
 * a receiver locally with a known secret. See {@link signV2} for the v2 scheme.
 */
export function sign(options: SignWebhookOptions): string {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return `${SIGNATURE_VERSION}=${computeSignature(options.secret, timestamp, rawBytes(options.payload))}`;
}

export interface SignWebhookV2Options extends SignWebhookOptions {
  /** Delivery id: must match the `izap-webhook-id` header value exactly. */
  id: string;
}

/**
 * Produces the `izap-webhook-signature-v2` value for a payload, e.g. to exercise a
 * receiver locally with a known secret. Unlike v1, this also signs `id`.
 */
export function signV2(options: SignWebhookV2Options): string {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return `${SIGNATURE_VERSION_V2}=${computeSignatureV2(options.secret, options.id, timestamp, rawBytes(options.payload))}`;
}

function computeSignature(
  secret: string,
  timestamp: string,
  body: Buffer,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
}

function computeSignatureV2(
  secret: string,
  id: string,
  timestamp: string,
  body: Buffer,
): string {
  return createHmac("sha256", secret)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest("hex");
}

function signatureMatches(
  headerValue: string,
  version: string,
  expectedHex: string,
): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  return headerValue
    .split(/[\s,]+/)
    .filter((entry) => entry.startsWith(`${version}=`))
    .map((entry) => entry.slice(version.length + 1))
    .filter((hex) => /^[0-9a-f]{64}$/i.test(hex))
    .some((hex) => timingSafeEqual(Buffer.from(hex, "hex"), expected));
}

function rawBytes(payload: unknown): Buffer {
  if (typeof payload === "string") return Buffer.from(payload, "utf8");
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new TypeError(
    "webhooks: `payload` must be the raw request body as a string or Buffer, not a parsed object.",
  );
}

function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return first || undefined;
  }
  return undefined;
}
