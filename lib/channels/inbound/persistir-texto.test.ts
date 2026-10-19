import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ marcar: vi.fn(), efeitos: vi.fn() }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: mocks.marcar }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: mocks.efeitos }));

import { persistirTextoEntranteNaInbox } from "./persistir-texto";
import type { InboundTextEvent } from "./types";

const input: InboundTextEvent = {
  organizationId: "org-1",
  channel: "telegram",
  channelSessionId: "session-1",
  contactId: "contact-1",
  conversationId: "conversation-1",
  externalId: "remote-message-1",
  text: "  Olá, preciso de ajuda  ",
  sentAt: "2026-10-19T12:00:00.000Z",
  contactName: "Ana Silva",
  origin: "provider_webhook",
  metadata: { remote_id: "123" },
  inboxOnly: true,
};

function adminFor(result: unknown) {
  const insert = {
    select: vi.fn(() => insert),
    maybeSingle: vi.fn(async () => result),
  };
  return {
    client: { from: vi.fn(() => ({ insert: vi.fn(() => insert) })) } as unknown as SupabaseClient,
    insert,
  };
}

describe("persistirTextoEntranteNaInbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("grava uma vez e encaminha efeitos compartilhados com a identidade resolvida", async () => {
    const { client, insert } = adminFor({ data: { id: "message-1" }, error: null });
    await expect(persistirTextoEntranteNaInbox(client, input)).resolves.toBe("ingested");
    expect(insert.maybeSingle).toHaveBeenCalledOnce();
    expect(mocks.marcar).toHaveBeenCalledWith(client, expect.objectContaining({
      conversationId: "conversation-1", preview: "Olá, preciso de ajuda", canal: "telegram",
    }));
    expect(mocks.efeitos).toHaveBeenCalledWith(client, expect.objectContaining({
      contactId: "contact-1", messageId: "message-1", texto: "Olá, preciso de ajuda",
      origem: "provider_webhook", apenasInbox: true,
    }));
  });

  it("trata a chave única como duplicata e não repete efeitos colaterais", async () => {
    const { client } = adminFor({ data: null, error: { code: "23505" } });
    await expect(persistirTextoEntranteNaInbox(client, input)).resolves.toBe("duplicate");
    expect(mocks.marcar).not.toHaveBeenCalled();
    expect(mocks.efeitos).not.toHaveBeenCalled();
  });
});
