import {
  createClient as createFetchClient,
  createConfig,
} from "./generated/client/index.js";
import { IzapApi } from "./generated/sdk.gen.js";
import type { ClientOptions } from "./generated/types.gen.js";
import { IzapApiError } from "./errors.js";
import { createRetryingFetch } from "./retry.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.izap.ai";

export interface IzapClientOptions {
  /** Personal access token (`izap_pat_…`), sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Default business for every request, sent as the `business-id` header. */
  businessId?: string;
  /** Defaults to https://api.izap.ai. */
  baseUrl?: string;
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Retries for idempotent requests on 429/502/503/504 and connection failures. Defaults to 2. */
  maxRetries?: number;
  /** Per-attempt timeout until response headers arrive. Defaults to 30000. */
  timeoutMs?: number;
}

/** Every public iZap API operation, as a method. */
export type IzapClient = IzapApi;

export function createClient(options: IzapClientOptions): IzapClient {
  const {
    token,
    businessId,
    baseUrl = DEFAULT_BASE_URL,
    maxRetries = 2,
    timeoutMs = 30_000,
  } = options;
  if (typeof token !== "string" || token.trim() === "") {
    throw new TypeError(
      "createClient: `token` is required (a personal access token, izap_pat_…).",
    );
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError("createClient: `maxRetries` must be an integer >= 0.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("createClient: `timeoutMs` must be a positive number.");
  }

  const baseFetch: typeof fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const headers: Record<string, string> = {
    "User-Agent": `izap-sdk-typescript/${VERSION}`,
  };
  if (businessId) headers["business-id"] = businessId;

  const client = createFetchClient(
    createConfig<ClientOptions>({
      baseUrl: baseUrl.replace(/\/+$/, ""),
      throwOnError: true,
      headers,
      auth: (auth) => (auth.scheme === "bearer" ? token : undefined),
      fetch: createRetryingFetch({ fetch: baseFetch, maxRetries, timeoutMs }),
    }),
  );

  client.interceptors.error.use((error, response, request) =>
    response
      ? new IzapApiError({
          status: response.status,
          body: error,
          headers: response.headers,
          request: request ? `${request.method} ${request.url}` : undefined,
        })
      : error,
  );

  return new IzapApi({ client });
}
