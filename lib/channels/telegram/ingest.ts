import type { SupabaseClient } from "@supabase/supabase-js";
import { persistirMensagemEntranteNaInbox } from "@/lib/channels/inbound/persistir-mensagem";
import type { InboundMessageEvent } from "@/lib/channels/inbound/types";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";

type TelegramMessage = {
  message_id?: unknown;
  date?: unknown;
  text?: unknown;
  caption?: unknown;
  photo?: unknown;
  audio?: unknown;
  voice?: unknown;
  document?: unknown;
  video?: unknown;
  chat?: { id?: unknown; type?: unknown; title?: unknown };
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
  const group = chat?.type === "group" || chat?.type === "supergroup";
  const media = extrairMidiaTelegram(message);
  const text = typeof message?.text === "string" ? message.text
    : typeof message?.caption === "string" ? message.caption : null;
  if (
    !message || !from || !chat || (chat.type !== "private" && !group) || from.is_bot === true ||
    (!text?.trim() && !media) ||
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

  // Receiving is an explicit grant for both private chats and groups. Without
  // this check, settings could disable reception while private updates kept
  // creating CRM conversations.
  const { data: inboxCapabilities, error: inboxCapabilitiesError } = await admin
    .from("telegram_bot_surface_capabilities")
    .select("capability")
    .eq("organization_id", input.organizationId)
    .eq("connection_id", input.connectionId)
    .eq("surface", "inbox")
    .in("capability", ["receive_messages", "ai_replies", "group_messages"]);
  if (inboxCapabilitiesError) return "ignored";
  const granted = new Set((inboxCapabilities ?? []).map((row: { capability: string }) => row.capability));
  if (!granted.has("receive_messages")) return "ignored";
  const aiRepliesEnabled = granted.has("ai_replies");

  const userId = String(from.id);
  const chatId = String(chat.id);
  const fullName = [from.first_name, from.last_name].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ");
  if (group) {
    if (!granted.has("group_messages")) return "ignored";
    // Discovery is always disabled; preserve any manager's allowlist choice.
    const title = typeof chat.title === "string" ? chat.title.slice(0, 200) : null;
    const { error: discoveryError } = await admin.from("channel_session_groups").upsert({
      organization_id: input.organizationId,
      channel_session_id: session.id,
      group_chat_id: chatId,
      subject: title,
      enabled: false,
    }, { onConflict: "organization_id,channel_session_id,group_chat_id", ignoreDuplicates: true });
    if (discoveryError) throw new Error("telegram_group_discovery_failed");
    const { data: allowlisted, error: allowlistError } = await admin.from("channel_session_groups")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("channel_session_id", session.id)
      .eq("group_chat_id", chatId)
      .eq("enabled", true)
      .maybeSingle();
    if (allowlistError || !allowlisted) return "ignored";
  }
  const identity = group ? `telegram:group:${chatId}` : `telegram:${userId}`;
  const { data: contactId, error: contactError } = await admin.rpc("fn_upsert_telegram_contact" as never, {
    p_org: input.organizationId,
    p_identity: identity,
    p_display_name: group
      ? (typeof chat.title === "string" ? chat.title : "Grupo Telegram")
      : fullName || (typeof from.username === "string" ? from.username : null),
  } as never);
  if (contactError || !contactId) throw new Error("telegram_contact_upsert_failed");

  const { data: conversationId, error: conversationError } = await admin.rpc("fn_upsert_telegram_conversation" as never, {
    p_org: input.organizationId,
    p_contact: contactId as string,
    p_session: session.id,
    p_provider_conversation_id: chatId,
    p_is_group: group,
    p_group_chat_id: group ? chatId : null,
  } as never);
  if (conversationError || !conversationId) throw new Error("telegram_conversation_upsert_failed");

  const sentAt = new Date((typeof message.date === "number" ? message.date : Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const externalId = `telegram:${input.connectionId}:${chatId}:${String(message.message_id)}`;
  const event: InboundMessageEvent = {
    organizationId: input.organizationId,
    channel: "telegram",
    channelSessionId: session.id,
    contactId: contactId as string,
    conversationId: conversationId as string,
    externalId,
    text,
    ...(media ? { media } : {}),
    sentAt,
    contactName: group ? (typeof chat.title === "string" ? chat.title : "Grupo Telegram") : fullName || null,
    origin: "telegram_webhook",
    metadata: {
      telegram_chat_id: chatId, telegram_user_id: userId, telegram_update_id: input.update.update_id,
      ...(group ? { group_sender: { name: fullName || (typeof from.username === "string" ? from.username : "Membro do grupo"), phone: null, lid: null } } : {}),
    },
    inboxOnly: group || !aiRepliesEnabled,
  };
  return persistirMensagemEntranteNaInbox(admin, event);
}

function extrairMidiaTelegram(message: TelegramMessage | undefined): InboundMessageEvent["media"] {
  if (!message) return undefined;
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) as Record<string, unknown> | undefined : undefined;
  const candidates: Array<{ kind: "image" | "audio" | "document" | "video"; value: unknown; fallbackMime: string }> = [
    { kind: "image", value: photo, fallbackMime: "image/jpeg" },
    { kind: "audio", value: message.voice ?? message.audio, fallbackMime: message.voice ? "audio/ogg" : "audio/mpeg" },
    { kind: "video", value: message.video, fallbackMime: "video/mp4" },
    { kind: "document", value: message.document, fallbackMime: "application/octet-stream" },
  ];
  const selected = candidates.find(({ value }) => value && typeof value === "object");
  if (!selected) return undefined;
  const file = selected.value as Record<string, unknown>;
  if (typeof file.file_id !== "string" || !file.file_id) return undefined;
  return {
    kind: selected.kind,
    reference: `telegram-media:${file.file_id}`,
    mime: typeof file.mime_type === "string" ? file.mime_type : selected.fallbackMime,
  };
}
