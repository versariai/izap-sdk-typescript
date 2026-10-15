# @izapai/sdk

TypeScript SDK for the [iZap](https://izap.ai) REST API: WhatsApp conversations,
message templates, bulk transmissions, business settings and outbound webhooks.

- Typed methods for every public operation, generated from iZap's public OpenAPI schema.
- Personal-access-token auth, automatic retries with backoff, and typed errors.
- `webhooks.verify()` for iZap's webhook signatures.

It is built for server-side use on Node.js 20 or later and ships as ESM with type
declarations. Full API reference: [devs.izap.ai](https://devs.izap.ai).

## Install

```bash
npm install @izapai/sdk
```

## Authenticate

Create a personal access token in the iZap dashboard under **User Settings → API
Keys**. API keys are available on plans that include the REST API. Tokens start with
`izap_pat_` and act as you, so keep them on the server and out of source control.

```ts
import { createClient } from "@izapai/sdk";

const izap = createClient({
  token: process.env.IZAP_TOKEN!, // izap_pat_…
  businessId: process.env.IZAP_BUSINESS_ID, // sent as the `business-id` header
});
```

`businessId` is optional. Most operations act on one business, and the header can
also be set per call: `izap.listWhatsAppTemplates({ headers: { "business-id": id } })`.
`izap.introspectToken()` tells you which user and business a token resolves to.

## Send a message

```ts
const { data: page } = await izap.listCurrentBusinessChats({
  query: { page_size: 20 },
});
const chat = page.chats[0]!;

const { data: sent } = await izap.sendChatMessage({
  path: { chat_id: chat.id },
  body: { content: "Olá! Seu pedido já saiu para entrega." },
});
```

The message is sent as a human agent, so the assistant does not reply to it. Outside
WhatsApp's 24-hour customer-service window, only an approved template can reach the
customer: use `izap.sendChatTemplateMessage()`.

## List templates

```ts
const { data } = await izap.listWhatsAppTemplates({
  query: { status: "approved" },
});
for (const template of data.templates) {
  console.log(template.name, template.language);
}
```

Every method resolves to `{ data, request, response }`, so response headers are
available too.

## Verify a webhook

iZap signs every webhook delivery (see
[Webhooks](https://devs.izap.ai/en/api-reference/webhooks)). Verify the **raw** request
body before trusting it; a body your framework has already parsed and re-serialized
no longer matches the signature.

```ts
import { webhooks, WebhookVerificationError } from "@izapai/sdk";

// Express: app.post("/hooks/izap", express.raw({ type: "application/json" }), handler)
function handler(req, res) {
  try {
    const event = webhooks.verify({
      payload: req.body, // Buffer or string: the raw body
      headers: req.headers,
      secret: process.env.IZAP_WEBHOOK_SECRET!, // izap_whsec_…
    });
    // event.id is stable across retries and resends: dedupe on it.
    if (event.data.event === "message.received") {
      console.log(event.data.message.text);
    }
    res.sendStatus(204);
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return res.status(400).send(error.code);
    }
    throw error;
  }
}
```

`verify()` requires the `izap-webhook-signature-v2` HMAC by default — it covers the
delivery id as well as the timestamp and body, closing a replay gap that v1 alone
has. Pass `allowV1: true` to accept a v1-only `izap-webhook-signature` header when
a delivery doesn't carry v2 (senders from before v2 shipped). Either check is
constant-time and rejects a delivery whose `izap-webhook-timestamp` is more than
`toleranceSec` (default 300) seconds from now. It throws `WebhookVerificationError` with a `code` of
`missing_header`, `invalid_timestamp`, `timestamp_out_of_tolerance`,
`invalid_signature` or `invalid_payload`. `webhooks.sign()` and `webhooks.signV2()`
produce a valid v1 or v2 signature for a payload, which helps when testing a receiver
locally.

## Errors

Any non-2xx response throws `IzapApiError`:

```ts
import { IzapApiError } from "@izapai/sdk";

try {
  await izap.createWhatsAppTemplate({ body: template });
} catch (error) {
  if (error instanceof IzapApiError) {
    error.status; // e.g. 403 or 422
    error.code; // a machine-readable code, when the API sends one
    error.detail; // the body's `detail`: a string, an object, or validation issues
    error.headers; // response headers
  }
}
```

Connection failures surface as the underlying `fetch` `TypeError`, and timeouts as a
`DOMException` named `TimeoutError`.

## Retries and timeouts

| Option       | Default               | Meaning                                            |
| ------------ | --------------------- | -------------------------------------------------- |
| `token`      | required              | Personal access token (`izap_pat_…`)               |
| `businessId` | none                  | Default `business-id` header                       |
| `baseUrl`    | `https://api.izap.ai` | API origin                                         |
| `fetch`      | `globalThis.fetch`    | Custom fetch implementation                        |
| `maxRetries` | `2`                   | Retries after the first attempt                    |
| `timeoutMs`  | `30000`               | Per-attempt timeout, until response headers arrive |

Only idempotent requests (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`) are retried, on
`429`, `502`, `503`, `504`, connection failures and timeouts. A `Retry-After` header
of up to 60 seconds is honoured; otherwise the delay backs off exponentially from
0.5 s with jitter, up to 8 s. `POST` and `PATCH` are never retried, so a send is
never duplicated.

## Development

The client under `src/generated/` is generated with
[`@hey-api/openapi-ts`](https://heyapi.dev) from `openapi/izap-public.json`, a copy of
iZap's public OpenAPI schema (the one served at `/api/v1/openapi.json`). The
hand-written layer in `src/` adds auth, retries, errors and webhooks.

```bash
npm ci
npm run sync:schema      # refresh openapi/izap-public.json (IZAP_OPENAPI_INPUT=<file|url> to pick the source)
npm run generate         # regenerate src/generated/ (IZAP_OPENAPI_INPUT overrides the input)
npm run check:generated  # fail if src/generated/ drifted from the schema
npm test                 # type-check (including examples/) and run the tests
npm run build            # emit dist/
```

Generating needs Node.js 22.18 or later; the published package runs on Node.js 20+.
Runnable samples live in [`examples/`](examples).

## License

[MIT](LICENSE)
