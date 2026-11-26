import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTelegramText = vi.fn();
const decryptWebhookSecret = vi.fn();

vi.mock("./bot-api", () => ({ sendTelegramText: (...args: unknown[]) => sendTelegramText(...args) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: (...args: unknown[]) => decryptWebhookSecret(...args) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/human-cases", () => ({
  resolveCaseFromHuman: vi.fn(),
  markAwaitingLead: vi.fn(),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/agent-engine/queue/queue", () => ({ enqueueJob: vi.fn() }));

import { handleTelegramHumanCaseUpdate } from "./human-cases";

function query(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => result);
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

describe("handleTelegramHumanCaseUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decryptWebhookSecret.mockResolvedValue("bot-token");
    sendTelegramText.mockResolvedValue(undefined);
  });

  it("consome comandos de casos após revogação da permissão para não encaminhá-los à Inbox", async () => {
    const admin = {
      from: vi.fn((table: string) => table === "telegram_bot_surface_capabilities"
        ? query({ data: [], error: null })
        : query({ data: { token_encrypted: "encrypted" }, error: null })),
    } as never;

    const consumed = await handleTelegramHumanCaseUpdate(admin, {
      organizationId: "org-1",
      connectionId: "bot-1",
      update: {
        message: {
          text: "/casos",
          chat: { id: 123, type: "private" },
          from: { id: 456, is_bot: false },
        },
      },
    });

    expect(consumed).toBe(true);
    expect(sendTelegramText).toHaveBeenCalledWith({
      token: "bot-token",
      chatId: "123",
      text: "Os comandos de casos estão desativados para este bot.",
    });
  });

  it("não consome comandos que não pertencem à superfície de casos", async () => {
    const from = vi.fn();
    const admin = { from } as never;
    const consumed = await handleTelegramHumanCaseUpdate(admin, {
      organizationId: "org-1",
      connectionId: "bot-1",
      update: {
        message: {
          text: "/start",
          chat: { id: 123, type: "private" },
          from: { id: 456, is_bot: false },
        },
      },
    });
    expect(consumed).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });
});
