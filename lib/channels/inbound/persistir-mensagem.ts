import type { SupabaseClient } from "@supabase/supabase-js";

import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";
import type { InboundMessageEvent } from "./types";

export type MensagemEntrantePersistida = "ingested" | "duplicate";

/**
 * Caso de uso comum para mensagem recebida por providers de mensagem.
 *
 * Parsers e adapters resolvem autenticação, identidade, conversa e ids remotos.
 * Depois disso todos persistem no mesmo ledger e executam os mesmos efeitos de
 * entrada. A chave idempotente do banco é a autoridade; em reentrega não se
 * repetem marcação de conversa, opt-out, handoff ou automações.
 */
export async function persistirMensagemEntranteNaInbox(
  admin: SupabaseClient,
  input: InboundMessageEvent,
): Promise<MensagemEntrantePersistida> {
  const text = input.text?.trim() ?? "";
  if ((!text && !input.media) || !input.externalId) throw new Error("inbound_message_invalid");

  const { data: inserted, error } = await admin.from("messages").insert({
    organization_id: input.organizationId,
    conversation_id: input.conversationId,
    channel_session_id: input.channelSessionId,
    contact_id: input.contactId,
    external_id: input.externalId,
    type: input.media?.kind ?? "text",
    direction: "inbound",
    status: "delivered",
    sent_via: "external_device",
    body: text || null,
    ...(input.media ? { media_url: input.media.reference, media_mime: input.media.mime } : {}),
    sent_at: input.sentAt,
    metadata: input.metadata,
  }).select("id").maybeSingle();
  if (error?.code === "23505") {
    if (input.media) {
      const { data: existing, error: lookupError } = await admin.from("messages")
        .select("id")
        .eq("organization_id", input.organizationId)
        .eq("external_id", input.externalId)
        .maybeSingle();
      if (lookupError || !existing) throw new Error("inbound_duplicate_media_lookup_failed");
      await enfileirarPersistenciaDeMidia(admin, input, (existing as { id: string }).id);
    }
    return "duplicate";
  }
  if (error || !inserted) throw new Error("inbound_message_insert_failed");

  await marcarConversaComMensagem(admin, {
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    direction: "inbound",
    preview: (text || `[${input.media?.kind ?? "mensagem"}]`).slice(0, 120),
    at: input.sentAt,
    canal: input.channel,
  });
  await aplicarEfeitosPosEntrada(admin, {
    organizationId: input.organizationId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    messageId: (inserted as { id: string }).id,
    channelSessionId: input.channelSessionId,
    texto: text || null,
    nomeDoContato: input.contactName,
    origem: input.origin,
    canal: input.channel,
    apenasInbox: input.inboxOnly,
  });
  if (input.media) await enfileirarPersistenciaDeMidia(admin, input, (inserted as { id: string }).id);
  return "ingested";
}

async function enfileirarPersistenciaDeMidia(
  admin: SupabaseClient,
  input: InboundMessageEvent,
  messageId: string,
): Promise<void> {
  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: "media.persist_requested",
    p_entity_kind: "message",
    p_entity_id: messageId,
    p_payload: { message_id: messageId, conversation_id: input.conversationId },
    p_metadata: { source: `${input.channel}_webhook` },
    p_organization_id: input.organizationId,
  } as never);
  if (error) throw new Error("inbound_media_enqueue_failed");
}
