import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TelegramConnectionsClient } from "@/components/connections/TelegramConnectionsClient";
import {
  deleteTelegramWebhook,
  getTelegramWebhookInfo,
  sendTelegramText,
  setTelegramWebhook,
  validateTelegramBotToken,
} from "@/lib/channels/telegram/bot-api";

describe("conexões Telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ data: { bots: [] } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("valida com getMe e devolve somente a identidade pública do bot", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: 9007199254740991,
            is_bot: true,
            first_name: "Atendimento",
            username: "clinica_bot",
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      validateTelegramBotToken("123456:abcdefghijklmnopqrstuvwxyz0123456789_-"),
    ).resolves.toEqual({
      id: "9007199254740991",
      username: "clinica_bot",
      firstName: "Atendimento",
    });
  });

  it("recusa respostas inválidas ou falhas de rede sem expor a credencial", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 }));
    await expect(
      validateTelegramBotToken("123456:abcdefghijklmnopqrstuvwxyz0123456789_-"),
    ).resolves.toBeNull();

    fetchSpy.mockRejectedValueOnce(new Error("network error"));
    await expect(
      validateTelegramBotToken("123456:abcdefghijklmnopqrstuvwxyz0123456789_-"),
    ).resolves.toBeNull();
  });

  it("configura e consulta webhook sem descartar updates pendentes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: {
          url: "https://crm.example/api/v1/webhooks/telegram/path-token",
          pending_update_count: 3,
          last_error_date: 1_800_000_000,
          last_error_message: "Connection timed out",
          allowed_updates: ["message", "edited_message", 7],
        },
      }), { status: 200 }));
    const token = "123456:abcdefghijklmnopqrstuvwxyz0123456789_-";
    await setTelegramWebhook({
      token,
      url: "https://crm.example/api/v1/webhooks/telegram/path-token",
      secretToken: "a-secure-webhook-secret-token",
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      secret_token: "a-secure-webhook-secret-token",
      drop_pending_updates: false,
      allowed_updates: ["message"],
    });
    await expect(getTelegramWebhookInfo(token)).resolves.toMatchObject({
      pendingUpdateCount: 3,
      lastErrorMessage: "Connection timed out",
      allowedUpdates: ["message", "edited_message"],
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(token);
  });

  it("envia texto e remove webhook sem expor respostas cruas da API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { message_id: 82, date: 1_800_000_001, chat: { id: 998877 } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    const token = "123456:abcdefghijklmnopqrstuvwxyz0123456789_-";
    await expect(sendTelegramText({ token, chatId: "998877", text: " Olá " }))
      .resolves.toEqual({ messageId: "82", chatId: "998877", date: 1_800_000_001 });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ chat_id: "998877", text: "Olá" });
    await expect(deleteTelegramWebhook(token)).resolves.toBeUndefined();
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({ drop_pending_updates: false });
  });

  it("abre as configurações após cadastrar e pré-seleciona só o atendimento humano", async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({
      data: {
        bot: {
          id: "connection-1",
          telegram_bot_id: "123456",
          bot_username: "clinica_bot",
          display_name: "Atendimento",
          token_last4: "6789",
          status: "draft",
          created_at: "2026-10-17T12:00:00Z",
        },
      },
    });
    render(<TelegramConnectionsClient />);

    await screen.findByText("Nenhum bot cadastrado");
    await user.type(screen.getByLabelText("Nome para identificar o bot"), "Atendimento");
    await user.type(
      screen.getByLabelText("Token do bot"),
      "123456:abcdefghijklmnopqrstuvwxyz0123456789_-",
    );
    await user.click(screen.getByRole("button", { name: "Validar e adicionar bot" }));

    await screen.findByRole("dialog");
    expect(screen.getByRole("checkbox", { name: /Atendimento na Inbox/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Respostas humanas/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Respostas automáticas de IA/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Mensagens em grupos/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Envio proativo/ })).not.toBeChecked();
    expect(screen.getByText(/recebe mensagens de texto em conversas privadas no Inbox/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Salvar configurações" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/api/v1/channels/telegram",
        expect.objectContaining({
          connection_id: "connection-1",
          bindings: [{ surface: "inbox", capabilities: ["receive_messages", "human_replies"] }],
        }),
      ),
    );
  });
});
