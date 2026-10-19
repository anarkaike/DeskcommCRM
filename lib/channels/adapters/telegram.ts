import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { fetchTelegramMedia, sendTelegramMedia, sendTelegramText } from "../telegram/bot-api";
import type { ChannelAdapter, OutboundEnvelope, RecipientInput } from "../types";

const NOT_CONFIGURED = "telegram_not_configured";

function tipoDeMidiaTelegram(kind: OutboundEnvelope["kind"]): kind is "image" | "video" | "audio" | "document" {
  return kind === "image" || kind === "video" || kind === "audio" || kind === "document";
}

/** Bot API transport. It translates the shared message and media contracts. */
export const telegramAdapter: ChannelAdapter = {
  provider: "telegram",
  resolveRecipient(input: RecipientInput): string | null {
    const chatId = input.providerConversationId;
    return chatId && /^-?\d{1,20}$/.test(chatId) ? chatId : null;
  },
  isConfigured: () => true,
  codes: { notConfigured: NOT_CONFIGURED, sendFailed: "telegram_send_failed", unknownError: "telegram_unknown" },
  async fetchInboundMedia(input) {
    const fileId = input.url.startsWith("telegram-media:") ? input.url.slice("telegram-media:".length) : "";
    if (!fileId) throw new Error("telegram_media_invalid_ref");
    const admin = createAdminClient();
    const { data, error } = await admin.from("telegram_bot_connections")
      .select("token_encrypted, status")
      .eq("organization_id", input.organizationId)
      .eq("id", input.sessionRef)
      .maybeSingle();
    if (error || !data || data.status !== "active") throw new Error(NOT_CONFIGURED);
    const token = await decryptWebhookSecret(admin, String(data.token_encrypted));
    if (!token) throw new Error(NOT_CONFIGURED);
    return fetchTelegramMedia({ token, fileId, hintMime: input.hintMime });
  },
  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const capability = envelope.actorType === "user"
      ? "human_replies"
      : envelope.actorType === "agent"
        ? "ai_replies"
        : null;
    if (!capability) throw new Error("telegram_sender_not_allowed");
    if (envelope.kind !== "text" && (!envelope.media || !tipoDeMidiaTelegram(envelope.kind))) {
      throw new Error("telegram_unsupported_message_type");
    }
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
    // O núcleo passa o id externo da mensagem citada, que é específico do
    // provider. A tradução para o message_id numérico da Bot API fica aqui.
    // Formatos aceitos: `chatId:messageId` (saída) e
    // `telegram:connectionId:chatId:messageId` (entrada).
    const replyToMessageId = envelope.replyToExternalId?.split(":").at(-1) ?? null;
    const reply = replyToMessageId && /^\d{1,20}$/.test(replyToMessageId) ? replyToMessageId : null;
    const mediaKind = tipoDeMidiaTelegram(envelope.kind) ? envelope.kind : null;
    const sent = envelope.media && mediaKind
      ? await sendTelegramMedia({
          token, chatId: envelope.to,
          kind: mediaKind,
          media: envelope.media,
          ...(reply ? { replyToMessageId: reply } : {}),
        })
      : await sendTelegramText({ token, chatId: envelope.to, text: envelope.body ?? "", ...(reply ? { replyToMessageId: reply } : {}) });
    return { externalId: `${sent.chatId}:${sent.messageId}` };
  },
};
