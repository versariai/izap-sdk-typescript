// List a business's approved WhatsApp message templates.
//
//   IZAP_TOKEN=izap_pat_... IZAP_BUSINESS_ID=<uuid> npx tsx examples/list-templates.ts
import { createClient } from "@izapai/sdk";

const izap = createClient({
  token: process.env.IZAP_TOKEN ?? "",
  businessId: process.env.IZAP_BUSINESS_ID,
});

const { data } = await izap.listWhatsAppTemplates({
  query: { status: "approved" },
});

console.log(`${data.total_count} approved template(s)`);
for (const template of data.templates) {
  console.log(
    `- ${template.name} (${template.language}): ${template.body_text}`,
  );
}
