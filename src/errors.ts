/** One entry of a FastAPI request-validation error (HTTP 422). */
export interface ValidationIssue {
  loc: Array<string | number>;
  msg: string;
  type: string;
  [key: string]: unknown;
}

/** A structured `detail`, e.g. `{ "code": "plan_limit_event_webhooks", "message": "…" }`. */
export interface ErrorDetailObject {
  code?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * The `detail` of an iZap error body (`{"detail": …}`): a plain message, a
 * structured object carrying a machine-readable `code`, or a list of validation issues.
 */
export type ErrorDetail = string | ErrorDetailObject | ValidationIssue[];

/** Thrown for every non-2xx response from the iZap API. */
export class IzapApiError extends Error {
  override readonly name = "IzapApiError";
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable error code, from `detail.code` or a top-level `code`, when present. */
  readonly code: string | undefined;
  /** The `detail` field of the error body, when the body had one. */
  readonly detail: ErrorDetail | undefined;
  /** The parsed JSON body, or the raw text when the body was not JSON. */
  readonly body: unknown;
  /** Response headers, e.g. `retry-after`. */
  readonly headers: Headers;
  /** `METHOD url` of the request that failed. */
  readonly request: string | undefined;

  constructor(init: {
    status: number;
    body: unknown;
    headers?: Headers;
    request?: string;
  }) {
    const detail = readDetail(init.body);
    const code = readCode(init.body, detail);
    const summary = summarize(init.body, detail) ?? `HTTP ${init.status}`;
    super(
      `iZap API error ${init.status}${code ? ` (${code})` : ""}: ${summary}`,
    );
    this.status = init.status;
    this.code = code;
    this.detail = detail;
    this.body = init.body;
    this.headers = init.headers ?? new Headers();
    this.request = init.request;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDetail(body: unknown): ErrorDetail | undefined {
  if (!isRecord(body)) return undefined;
  const { detail } = body;
  if (typeof detail === "string" || Array.isArray(detail) || isRecord(detail)) {
    return detail as ErrorDetail;
  }
  return undefined;
}

function readCode(
  body: unknown,
  detail: ErrorDetail | undefined,
): string | undefined {
  if (isRecord(detail) && typeof detail.code === "string") return detail.code;
  if (isRecord(body) && typeof body.code === "string") return body.code;
  return undefined;
}

function summarize(
  body: unknown,
  detail: ErrorDetail | undefined,
): string | undefined {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((issue) =>
        issue?.loc ? `${issue.loc.join(".")}: ${issue.msg}` : String(issue),
      )
      .join("; ");
  }
  if (isRecord(detail)) {
    return typeof detail.message === "string"
      ? detail.message
      : JSON.stringify(detail);
  }
  if (isRecord(body) && typeof body.message === "string") return body.message;
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500);
  return undefined;
}
