import type { SupabaseClient } from "@supabase/supabase-js";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";

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

  const { data: session, error: sessionError } = await admin.from("channel_sessions")
    .select("id, status")
    .eq("organization_id", input.organizationId)
    .eq("telegram_bot_connection_id", input.connectionId)
    .maybeSingle();
  if (sessionError) throw new Error("telegram_session_lookup_failed");
  if (!session || session.status !== "WORKING") return "ignored";

  const userId = String(from.id);
  const chatId = String(chat.id);
  const fullName = [from.first_name, from.last_name].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ");
  const identity = `telegram:${userId}`;
  const { data: contactId, error: contactError } = await admin.rpc("fn_upsert_telegram_contact" as never, {
    p_org: input.organizationId, p_identity: identity, p_display_name: fullName || (typeof from.username === "string" ? from.username : null),
  } as never);
  if (contactError || !contactId) throw new Error("telegram_contact_upsert_failed");

  const { data: conversationId, error: conversationError } = await admin.rpc("fn_upsert_telegram_conversation" as never, {
    p_org: input.organizationId, p_contact: contactId as string, p_session: session.id,
  } as never);
  if (conversationError || !conversationId) throw new Error("telegram_conversation_upsert_failed");

  const sentAt = new Date((typeof message.date === "number" ? message.date : Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const externalId = `telegram:${input.connectionId}:${chatId}:${String(message.message_id)}`;
  const { data: inserted, error: messageError } = await admin.from("messages").insert({
    organization_id: input.organizationId,
    conversation_id: conversationId as string,
    channel_session_id: session.id,
    contact_id: contactId as string,
    external_id: externalId,
    type: "text",
    direction: "inbound",
    status: "delivered",
    sent_via: "external_device",
    body: message.text.trim(),
    sent_at: sentAt,
    metadata: { telegram_chat_id: chatId, telegram_user_id: userId, telegram_update_id: input.update.update_id },
  }).select("id").maybeSingle();
  if (messageError?.code === "23505") return "duplicate";
  if (messageError || !inserted) throw new Error("telegram_message_insert_failed");

  await marcarConversaComMensagem(admin, {
    organizationId: input.organizationId,
    conversationId: conversationId as string,
    direction: "inbound",
    preview: message.text.trim().slice(0, 120),
    at: sentAt,
    canal: "telegram",
  });
  await aplicarEfeitosPosEntrada(admin, {
    organizationId: input.organizationId,
    contactId: contactId as string,
    conversationId: conversationId as string,
    messageId: (inserted as { id: string }).id,
    channelSessionId: session.id,
    texto: message.text.trim(),
    nomeDoContato: fullName || null,
    origem: "telegram_webhook",
    canal: "telegram",
    apenasInbox: true,
  });
  return "ingested";
}
