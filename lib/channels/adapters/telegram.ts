import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { sendTelegramText } from "../telegram/bot-api";
import type { ChannelAdapter, OutboundEnvelope, RecipientInput } from "../types";

const NOT_CONFIGURED = "telegram_not_configured";

/** Bot API transport. It only translates the shared text-send contract. */
export const telegramAdapter: ChannelAdapter = {
  provider: "telegram",
  resolveRecipient(input: RecipientInput): string | null {
    const chatId = input.providerConversationId;
    return chatId && /^-?\d{1,20}$/.test(chatId) ? chatId : null;
  },
  isConfigured: () => true,
  codes: { notConfigured: NOT_CONFIGURED, sendFailed: "telegram_send_failed", unknownError: "telegram_unknown" },
  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const capability = envelope.actorType === "user"
      ? "human_replies"
      : envelope.actorType === "agent"
        ? "ai_replies"
        : null;
    if (!capability) throw new Error("telegram_sender_not_allowed");
    if (envelope.kind !== "text") throw new Error("telegram_unsupported_message_type");
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("telegram_bot_connections")
      .select("token_encrypted, status")
      .eq("organization_id", envelope.organizationId)
      .eq("id", envelope.sessionRef)
      .maybeSingle();
    if (error || !data || data.status !== "active") throw new Error(NOT_CONFIGURED);
    const { data: permission, error: permissionError } = await admin.from("telegram_bot_surface_capabilities")
      .select("id")
      .eq("organization_id", envelope.organizationId)
      .eq("connection_id", envelope.sessionRef)
      .eq("surface", "inbox")
      .eq("capability", capability)
      .maybeSingle();
    if (permissionError || !permission) throw new Error("telegram_reply_not_enabled");
    const token = await decryptWebhookSecret(admin, String(data.token_encrypted));
    if (!token) throw new Error(NOT_CONFIGURED);
    const sent = await sendTelegramText({ token, chatId: envelope.to, text: envelope.body ?? "" });
    return { externalId: `${sent.chatId}:${sent.messageId}` };
  },
};
