import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/channels/telegram/bot-api", () => ({
  fetchTelegramMedia: vi.fn(),
  getTelegramWebhookInfo: vi.fn(),
  sendTelegramMedia: vi.fn(),
  sendTelegramText: vi.fn(),
  validateTelegramBotToken: vi.fn(),
}));

import { telegramAdapter } from "@/lib/channels/adapters/telegram";

describe("adapter Telegram atual", () => {
  it("endereça conversa pelo chat_id numérico recebido do provider", () => {
    const input = {
      isGroup: false,
      groupChatId: null,
      phoneNumber: null,
      waIdentity: null,
      providerConversationId: "-1001234567890",
    };
    expect(telegramAdapter.resolveRecipient(input)).toBe("-1001234567890");
    expect(telegramAdapter.resolveRecipient({ ...input, providerConversationId: "not-a-chat-id" })).toBeNull();
  });

  it("recusa remetentes de sistema antes de consultar credenciais", async () => {
    mocks.admin.mockClear();
    await expect(
      telegramAdapter.send({
        organizationId: "org-1",
        actorType: "system",
        sessionRef: "connection-1",
        to: "123456789",
        kind: "text",
        body: "mensagem automática",
      }),
    ).rejects.toThrow("telegram_sender_not_allowed");
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
