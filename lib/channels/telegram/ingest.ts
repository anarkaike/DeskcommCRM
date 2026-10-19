import type { SupabaseClient } from "@supabase/supabase-js";
import { persistirTextoEntranteNaInbox } from "@/lib/channels/inbound/persistir-texto";
import type { InboundTextEvent } from "@/lib/channels/inbound/types";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";

type TelegramMessage = {
  message_id?: unknown;
  date?: unknown;
  text?: unknown;
  chat?: { id?: unknown; type?: unknown };
  from?: { id?: unknown; is_bot?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown };
};

export type TelegramIngestResult = "ingested" | "duplicate" | "ignored";

/** Converts supported private text updates into the shared CRM conversation ledger. */
export async function ingestTelegramUpdate(
  admin: SupabaseClient,
  input: { organizationId: string; connectionId: string; update: Record<string, unknown> },
): Promise<TelegramIngestResult> {
  const message = input.update.message as TelegramMessage | undefined;
  const from = message?.from;
  const chat = message?.chat;
  if (
    !message || !from || !chat || chat.type !== "private" || from.is_bot === true ||
    (typeof message.text !== "string") || !message.text.trim() ||
    (typeof message.message_id !== "number" && typeof message.message_id !== "string") ||
    (typeof from.id !== "number" && typeof from.id !== "string") ||
    (typeof chat.id !== "number" && typeof chat.id !== "string")
  ) return "ignored";

  const sessionQuery = () => admin.from("channel_sessions")
    .select("id, status")
    .eq("organization_id", input.organizationId)
    .eq("telegram_bot_connection_id", input.connectionId);
  const { data: session, error: sessionError } = await queryTolerantToMissingArchived(
    () => sessionQuery().is(ARCHIVED_AT, null).maybeSingle(),
    () => sessionQuery().maybeSingle(),
  );
  if (sessionError) throw new Error("telegram_session_lookup_failed");
  if (!session || session.status !== "WORKING") return "ignored";

  // O binding ai_replies habilita o pipeline comum do CRM, que ainda aplica
  // autorização do contato, gates e políticas antes de qualquer resposta.
  // Erro de leitura falha fechado: conserva a mensagem na Inbox humana.
  const { data: aiCapability, error: aiCapabilityError } = await admin
    .from("telegram_bot_surface_capabilities")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("connection_id", input.connectionId)
    .eq("surface", "inbox")
    .eq("capability", "ai_replies")
    .maybeSingle();
  const aiRepliesEnabled = !aiCapabilityError && Boolean(aiCapability);

  const userId = String(from.id);
  const chatId = String(chat.id);
  const fullName = [from.first_name, from.last_name].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ");
  const identity = `telegram:${userId}`;
  const { data: contactId, error: contactError } = await admin.rpc("fn_upsert_telegram_contact" as never, {
    p_org: input.organizationId, p_identity: identity, p_display_name: fullName || (typeof from.username === "string" ? from.username : null),
  } as never);
  if (contactError || !contactId) throw new Error("telegram_contact_upsert_failed");

  const { data: conversationId, error: conversationError } = await admin.rpc("fn_upsert_telegram_conversation" as never, {
    p_org: input.organizationId,
    p_contact: contactId as string,
    p_session: session.id,
    p_provider_conversation_id: chatId,
  } as never);
  if (conversationError || !conversationId) throw new Error("telegram_conversation_upsert_failed");

  const sentAt = new Date((typeof message.date === "number" ? message.date : Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const externalId = `telegram:${input.connectionId}:${chatId}:${String(message.message_id)}`;
  const event: InboundTextEvent = {
    organizationId: input.organizationId,
    channel: "telegram",
    channelSessionId: session.id,
    contactId: contactId as string,
    conversationId: conversationId as string,
    externalId,
    text: message.text,
    sentAt,
    contactName: fullName || null,
    origin: "telegram_webhook",
    metadata: { telegram_chat_id: chatId, telegram_user_id: userId, telegram_update_id: input.update.update_id },
    inboxOnly: !aiRepliesEnabled,
  };
  return persistirTextoEntranteNaInbox(admin, event);
}
