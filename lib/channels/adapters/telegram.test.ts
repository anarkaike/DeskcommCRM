import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), sendMedia: vi.fn(), fetchMedia: vi.fn(), decrypt: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: mocks.decrypt }));
vi.mock("../telegram/bot-api", () => ({ sendTelegramText: mocks.send, sendTelegramMedia: mocks.sendMedia, fetchTelegramMedia: mocks.fetchMedia }));

import { telegramAdapter } from "./telegram";

function query(result: unknown) {
  const q = {
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    maybeSingle: vi.fn(async () => result),
  };
  return q;
}

describe("Telegram channel adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockResolvedValue("server-only-token");
    mocks.send.mockResolvedValue({ messageId: "88", chatId: "987654321", date: 1_800_000_000 });
    mocks.sendMedia.mockResolvedValue({ messageId: "89", chatId: "987654321", date: 1_800_000_001 });
  });

  it("uses the provider thread id as the destination rather than requiring a phone", () => {
    expect(telegramAdapter.resolveRecipient({
      isGroup: false,
      groupChatId: null,
      phoneNumber: null,
      waIdentity: null,
      providerConversationId: "987654321",
    })).toBe("987654321");
    expect(telegramAdapter.resolveRecipient({
      isGroup: false,
      groupChatId: null,
      phoneNumber: null,
      waIdentity: null,
      providerConversationId: null,
    })).toBeNull();
  });

  it("sends a human text reply using the tenant bot and the saved conversation destination", async () => {
    const connection = query({ data: { token_encrypted: "ciphertext", status: "active" }, error: null });
    const capability = query({ data: { id: "capability-1" }, error: null });
    mocks.admin.mockReturnValue({ from: vi.fn((table: string) => table === "telegram_bot_connections" ? connection : capability) });

    await expect(telegramAdapter.send({
      organizationId: "org-1",
      actorType: "user",
      sessionRef: "connection-1",
      to: "987654321",
      kind: "text",
      body: "Olá, Ana",
    })).resolves.toEqual({ externalId: "987654321:88" });

    expect(connection.eq).toHaveBeenCalledWith("organization_id", "org-1");
    expect(connection.eq).toHaveBeenCalledWith("id", "connection-1");
    expect(capability.eq).toHaveBeenCalledWith("capability", "human_replies");
    expect(mocks.decrypt).toHaveBeenCalledWith(expect.anything(), "ciphertext");
    expect(mocks.send).toHaveBeenCalledWith({ token: "server-only-token", chatId: "987654321", text: "Olá, Ana" });
  });

  it("translates the shared reply reference to Telegram's numeric message id", async () => {
    const connection = query({ data: { token_encrypted: "ciphertext", status: "active" }, error: null });
    const capability = query({ data: { id: "capability-1" }, error: null });
    mocks.admin.mockReturnValue({ from: vi.fn((table: string) => table === "telegram_bot_connections" ? connection : capability) });

    await telegramAdapter.send({
      organizationId: "org-1", actorType: "user", sessionRef: "connection-1",
      to: "987654321", kind: "text", body: "Respondendo à mensagem",
      replyToExternalId: "telegram:connection-1:987654321:51",
    });

    expect(mocks.send).toHaveBeenCalledWith({
      token: "server-only-token", chatId: "987654321", text: "Respondendo à mensagem",
      replyToMessageId: "51",
    });
  });

  it("fails closed for non-human senders before loading credentials", async () => {
    await expect(telegramAdapter.send({
      organizationId: "org-1",
      actorType: "system",
      sessionRef: "connection-1",
      to: "987654321",
      kind: "text",
      body: "automated",
    })).rejects.toThrow("telegram_sender_not_allowed");
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("allows an agent reply only when the tenant granted ai_replies", async () => {
    const connection = query({ data: { token_encrypted: "ciphertext", status: "active" }, error: null });
    const capability = query({ data: { id: "ai-capability" }, error: null });
    mocks.admin.mockReturnValue({ from: vi.fn((table: string) => table === "telegram_bot_connections" ? connection : capability) });
    await expect(telegramAdapter.send({
      organizationId: "org-1", actorType: "agent", sessionRef: "connection-1",
      to: "987654321", kind: "text", body: "Resposta automática",
    })).resolves.toEqual({ externalId: "987654321:88" });
    expect(capability.eq).toHaveBeenCalledWith("capability", "ai_replies");
  });

  it("maps a shared image envelope to Telegram media send", async () => {
    const connection = query({ data: { token_encrypted: "ciphertext", status: "active" }, error: null });
    const capability = query({ data: { id: "capability-1" }, error: null });
    mocks.admin.mockReturnValue({ from: vi.fn((table: string) => table === "telegram_bot_connections" ? connection : capability) });
    await expect(telegramAdapter.send({
      organizationId: "org-1", actorType: "user", sessionRef: "connection-1", to: "987654321",
      kind: "image", body: "Legenda", media: { url: "https://storage.example/signed", mime: "image/jpeg", caption: "Legenda" },
    })).resolves.toEqual({ externalId: "987654321:89" });
    expect(mocks.sendMedia).toHaveBeenCalledWith({
      token: "server-only-token", chatId: "987654321", kind: "image",
      media: { url: "https://storage.example/signed", mime: "image/jpeg", caption: "Legenda" },
    });
  });
});
