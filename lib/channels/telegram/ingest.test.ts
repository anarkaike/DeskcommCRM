import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ marcarConversa: vi.fn(), aplicarEfeitos: vi.fn() }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: mocks.marcarConversa }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: mocks.aplicarEfeitos }));

import { ingestTelegramUpdate } from "./ingest";

function builder(result: unknown) {
  const self = {
    select: vi.fn(() => self),
    eq: vi.fn(() => self),
    maybeSingle: vi.fn(async () => result),
  };
  return self;
}

describe("Telegram inbound Inbox adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes a private text update into shared contact, conversation and message records", async () => {
    const session = builder({ data: { id: "session-1", status: "WORKING" }, error: null });
    const messageInsert = {
      select: vi.fn(() => ({ maybeSingle: async () => ({ data: { id: "message-1" }, error: null }) })),
    };
    const admin = {
      from: vi.fn((table: string) => table === "channel_sessions"
        ? session
        : { insert: vi.fn(() => messageInsert) }),
      rpc: vi.fn(async (name: string) => name === "fn_upsert_telegram_contact"
        ? { data: "contact-1", error: null }
        : { data: "conversation-1", error: null }),
    } as unknown as SupabaseClient;
    const update = {
      update_id: 12,
      message: {
        message_id: 51,
        date: 1_800_000_000,
        text: "Olá, preciso de ajuda",
        chat: { id: 987654321, type: "private" },
        from: { id: 987654321, first_name: "Ana", last_name: "Silva" },
      },
    };

    const result = await ingestTelegramUpdate(admin, {
      organizationId: "org-1", connectionId: "bot-1", update,
    });

    expect(result).toBe("ingested");
    expect(admin.rpc).toHaveBeenNthCalledWith(1, "fn_upsert_telegram_contact", expect.objectContaining({
      p_org: "org-1", p_identity: "telegram:987654321", p_display_name: "Ana Silva",
    }));
    expect(admin.rpc).toHaveBeenNthCalledWith(2, "fn_upsert_telegram_conversation", expect.objectContaining({
      p_org: "org-1", p_contact: "contact-1", p_session: "session-1",
    }));
    expect(mocks.aplicarEfeitos).toHaveBeenCalledWith(admin, expect.objectContaining({
      organizationId: "org-1", conversationId: "conversation-1", canal: "telegram", apenasInbox: true,
    }));
    expect(mocks.marcarConversa).toHaveBeenCalledOnce();
  });

  it("ignores groups, media-only and non-message updates", async () => {
    const admin = { from: vi.fn(), rpc: vi.fn() } as unknown as SupabaseClient;
    const result = await ingestTelegramUpdate(admin, {
      organizationId: "org-1", connectionId: "bot-1", update: { update_id: 1, message: { message_id: 2, photo: [{}] } },
    });
    expect(result).toBe("ignored");
    expect(admin.from).not.toHaveBeenCalled();
  });
});
