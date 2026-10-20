import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ persistir: vi.fn(), capability: vi.fn() }));
vi.mock("@/lib/channels/inbound/persistir-mensagem", () => ({ persistirMensagemEntranteNaInbox: mocks.persistir }));

import { ingestTelegramUpdate } from "./ingest";

function builder(result: unknown) {
  const self = {
    select: vi.fn(() => self),
    eq: vi.fn(() => self),
    in: vi.fn(() => self),
    is: vi.fn(() => self),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return self;
}

describe("Telegram inbound Inbox adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistir.mockResolvedValue("ingested");
    mocks.capability.mockResolvedValue({ data: null, error: null });
  });

  it("normalizes a private text update into shared contact, conversation and message records", async () => {
    const session = builder({ data: { id: "session-1", status: "WORKING" }, error: null });
    const admin = {
      from: vi.fn((table: string) => table === "channel_sessions"
        ? session
        : table === "telegram_bot_surface_capabilities"
          ? builder({ data: [{ capability: "receive_messages" }], error: null })
          : {}),
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
      p_provider_conversation_id: "987654321",
    }));
    expect(mocks.persistir).toHaveBeenCalledWith(admin, expect.objectContaining({
      organizationId: "org-1", conversationId: "conversation-1", channel: "telegram", inboxOnly: true,
      externalId: "telegram:bot-1:987654321:51", text: "Olá, preciso de ajuda",
    }));
  });

  it("ignora mensagens privadas quando receive_messages foi revogado", async () => {
    const session = builder({ data: { id: "session-1", status: "WORKING" }, error: null });
    const admin = {
      from: vi.fn((table: string) => table === "channel_sessions" ? session : builder({ data: [], error: null })),
      rpc: vi.fn(),
    } as unknown as SupabaseClient;
    const result = await ingestTelegramUpdate(admin, {
      organizationId: "org-1", connectionId: "bot-1",
      update: { update_id: 19, message: { message_id: 61, text: "Oi", chat: { id: 123, type: "private" }, from: { id: 123 } } },
    });
    expect(result).toBe("ignored");
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(mocks.persistir).not.toHaveBeenCalled();
  });

  it("retém mensagem na Inbox quando a capacidade de IA não está concedida", async () => {
    const session = builder({ data: { id: "session-1", status: "WORKING" }, error: null });
    const admin = {
      from: vi.fn((table: string) => table === "channel_sessions"
        ? session
        : builder({ data: [{ capability: "receive_messages" }], error: null })),
      rpc: vi.fn(async (name: string) => name === "fn_upsert_telegram_contact"
        ? { data: "contact-1", error: null }
        : { data: "conversation-1", error: null }),
    } as unknown as SupabaseClient;
    const update = { update_id: 12, message: { message_id: 51, text: "Oi", chat: { id: 123, type: "private" }, from: { id: 123 } } };
    await ingestTelegramUpdate(admin, { organizationId: "org-1", connectionId: "bot-1", update });
    expect(mocks.persistir).toHaveBeenCalledWith(admin, expect.objectContaining({ inboxOnly: true }));
  });

  it("despacha para o pipeline comum de IA só com capability concedida", async () => {
    const session = builder({ data: { id: "session-1", status: "WORKING" }, error: null });
    const admin = {
      from: vi.fn((table: string) => table === "channel_sessions"
        ? session
        : builder({ data: [{ capability: "receive_messages" }, { capability: "ai_replies" }], error: null })),
      rpc: vi.fn(async (name: string) => name === "fn_upsert_telegram_contact"
        ? { data: "contact-1", error: null }
        : { data: "conversation-1", error: null }),
    } as unknown as SupabaseClient;
    const update = { update_id: 12, message: { message_id: 51, text: "Oi", chat: { id: 123, type: "private" }, from: { id: 123 } } };
    await ingestTelegramUpdate(admin, { organizationId: "org-1", connectionId: "bot-1", update });
    expect(mocks.persistir).toHaveBeenCalledWith(admin, expect.objectContaining({ inboxOnly: false }));
  });

  it("ignores groups until receive and group-message capabilities are both granted", async () => {
    const session = builder({ data: { id: "session-1", status: "WORKING" }, error: null });
    const admin = {
      from: vi.fn((table: string) => table === "channel_sessions"
        ? session
        : table === "telegram_bot_surface_capabilities"
          ? builder({ data: null, error: null })
          : {}),
      rpc: vi.fn(),
    } as unknown as SupabaseClient;
    const result = await ingestTelegramUpdate(admin, {
      organizationId: "org-1", connectionId: "bot-1", update: { update_id: 1, message: { message_id: 2, chat: { id: 123, type: "group" }, from: { id: 123 }, text: "Oi" } },
    });
    expect(result).toBe("ignored");
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(mocks.persistir).not.toHaveBeenCalled();
  });

  it("ignores non-message Telegram updates", async () => {
    const admin = { from: vi.fn(), rpc: vi.fn() } as unknown as SupabaseClient;
    const result = await ingestTelegramUpdate(admin, {
      organizationId: "org-1", connectionId: "bot-1", update: { update_id: 1, callback_query: { id: "callback-1" } },
    });
    expect(result).toBe("ignored");
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("normaliza foto sem legenda para o evento comum com referência Telegram", async () => {
    const session = builder({ data: { id: "session-1", status: "WORKING" }, error: null });
    const admin = {
      from: vi.fn((table: string) => table === "channel_sessions"
        ? session
         : builder({ data: [{ capability: "receive_messages" }], error: null })),
      rpc: vi.fn(async (name: string) => name === "fn_upsert_telegram_contact"
        ? { data: "contact-1", error: null }
        : { data: "conversation-1", error: null }),
    } as unknown as SupabaseClient;
    const result = await ingestTelegramUpdate(admin, {
      organizationId: "org-1", connectionId: "bot-1", update: {
        update_id: 13,
        message: {
          message_id: 52, date: 1_800_000_000,
          chat: { id: 987654321, type: "private" },
          from: { id: 987654321, first_name: "Ana" },
          photo: [{ file_id: "small" }, { file_id: "largest_file", file_size: 1234 }],
        },
      },
    });
    expect(result).toBe("ingested");
    expect(mocks.persistir).toHaveBeenCalledWith(admin, expect.objectContaining({
      text: null,
      media: { kind: "image", reference: "telegram-media:largest_file", mime: "image/jpeg" },
    }));
  });
});
