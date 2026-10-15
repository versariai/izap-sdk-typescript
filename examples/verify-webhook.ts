// A minimal webhook receiver that verifies iZap's signature before trusting a delivery.
//
//   IZAP_WEBHOOK_SECRET=izap_whsec_... npx tsx examples/verify-webhook.ts
import { createServer } from "node:http";

import { webhooks, WebhookVerificationError } from "@izapai/sdk";

const secret = process.env.IZAP_WEBHOOK_SECRET ?? "";
const seen = new Set<string>();

createServer(async (req, res) => {
  // Verify the raw bytes: a re-serialized JSON body no longer matches the signature.
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  try {
    const event = webhooks.verify({
      payload: Buffer.concat(chunks),
      headers: req.headers,
      secret,
    });

    // Retries and resends reuse the delivery id.
    if (!seen.has(event.id)) {
      seen.add(event.id);
      if (event.data.event === "message.received") {
        console.log(`${event.data.message.from}: ${event.data.message.text}`);
      }
    }
    res.writeHead(204).end();
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      res.writeHead(400).end(error.code);
      return;
    }
    res.writeHead(500).end();
  }
}).listen(3000, () => console.log("Listening on http://localhost:3000"));
