import type { SupabaseClient } from "@supabase/supabase-js";

import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";
import type { InboundTextEvent } from "./types";

export type TextoEntrantePersistido = "ingested" | "duplicate";

/**
 * Caso de uso comum para texto recebido por providers de mensagem.
 *
 * Parsers e adapters resolvem autenticação, identidade, conversa e ids remotos.
 * Depois disso todos persistem no mesmo ledger e executam os mesmos efeitos de
 * entrada. A chave idempotente do banco é a autoridade; em reentrega não se
 * repetem marcação de conversa, opt-out, handoff ou automações.
 */
export async function persistirTextoEntranteNaInbox(
  admin: SupabaseClient,
  input: InboundTextEvent,
): Promise<TextoEntrantePersistido> {
  const text = input.text.trim();
  if (!text || !input.externalId) throw new Error("inbound_text_invalid");

  const { data: inserted, error } = await admin.from("messages").insert({
    organization_id: input.organizationId,
    conversation_id: input.conversationId,
    channel_session_id: input.channelSessionId,
    contact_id: input.contactId,
    external_id: input.externalId,
    type: "text",
    direction: "inbound",
    status: "delivered",
    sent_via: "external_device",
    body: text,
    sent_at: input.sentAt,
    metadata: input.metadata,
  }).select("id").maybeSingle();
  if (error?.code === "23505") return "duplicate";
  if (error || !inserted) throw new Error("inbound_message_insert_failed");

  await marcarConversaComMensagem(admin, {
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    direction: "inbound",
    preview: text.slice(0, 120),
    at: input.sentAt,
    canal: input.channel,
  });
  await aplicarEfeitosPosEntrada(admin, {
    organizationId: input.organizationId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    messageId: (inserted as { id: string }).id,
    channelSessionId: input.channelSessionId,
    texto: text,
    nomeDoContato: input.contactName,
    origem: input.origin,
    canal: input.channel,
    apenasInbox: input.inboxOnly,
  });
  return "ingested";
}
