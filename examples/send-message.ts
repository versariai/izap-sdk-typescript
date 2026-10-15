// Send a message into a business's most recent WhatsApp conversation.
//
//   IZAP_TOKEN=izap_pat_... IZAP_BUSINESS_ID=<uuid> npx tsx examples/send-message.ts
import { createClient, IzapApiError } from "@izapai/sdk";

const izap = createClient({
  token: process.env.IZAP_TOKEN ?? "",
  businessId: process.env.IZAP_BUSINESS_ID,
});

try {
  const { data: page } = await izap.listCurrentBusinessChats({
    query: { page_size: 1 },
  });
  const chat = page.chats[0];
  if (!chat) {
    console.log("No conversations yet.");
  } else {
    // Sent as a human agent: the assistant does not reply to it. Outside WhatsApp's
    // 24-hour customer-service window, use sendChatTemplateMessage instead.
    const { data: sent } = await izap.sendChatMessage({
      path: { chat_id: chat.id },
      body: { content: "Olá! Seu pedido já saiu para entrega." },
    });
    console.log("Sent message", sent.user_message.id);
  }
} catch (error) {
  if (error instanceof IzapApiError) {
    console.error(error.status, error.code, error.message);
  }
  throw error;
}
