import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/channels/usePacingKnobs", () => ({
  usePacingKnobs: () => ({ data: { items: [] } }),
}));
vi.mock("@/hooks/channels/usePacingKnobs", () => ({
  usePacingKnobs: () => ({ data: { items: [] } }),
}));

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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              url: "https://crm.example/api/v1/webhooks/telegram/path-token",
              pending_update_count: 3,
              last_error_date: 1_800_000_000,
              last_error_message: "Connection timed out",
              allowed_updates: ["message", "edited_message", 7],
            },
          }),
          { status: 200 },
        ),
      );
    const token = "123456:abcdefghijklmnopqrstuvwxyz0123456789_-";
    await setTelegramWebhook({
      token,
      url: "https://crm.example/api/v1/webhooks/telegram/path-token",
      secretToken: "a-secure-webhook-secret-token",
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      secret_token: "a-secure-webhook-secret-token",
      drop_pending_updates: false,
      allowed_updates: [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "callback_query",
        "chat_member",
        "my_chat_member",
      ],
    });
    await expect(getTelegramWebhookInfo(token)).resolves.toMatchObject({
      pendingUpdateCount: 3,
      lastErrorMessage: "Connection timed out",
      allowedUpdates: ["message", "edited_message"],
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(token);
  });

  it("envia texto e remove webhook sem expor respostas cruas da API", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 82, date: 1_800_000_001, chat: { id: 998877 } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
      );
    const token = "123456:abcdefghijklmnopqrstuvwxyz0123456789_-";
    await expect(sendTelegramText({ token, chatId: "998877", text: " Olá " })).resolves.toEqual({
      messageId: "82",
      chatId: "998877",
      date: 1_800_000_001,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      chat_id: "998877",
      text: "Olá",
    });
    await expect(deleteTelegramWebhook(token)).resolves.toBeUndefined();
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
      drop_pending_updates: false,
    });
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
    expect(screen.getByRole("checkbox", { name: /Mensagens de grupos/ })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /Envio proativo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Avisos da equipe/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /Ferramentas de agente/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Mini App/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Casos humanos exigem pareamento de cada operador/i),
    ).toBeInTheDocument();

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

  it("expõe e aciona as transições de ativar, pausar, reativar, desconectar e excluir", async () => {
    const user = userEvent.setup();
    const bot = {
      id: "connection-1",
      telegram_bot_id: "123456",
      bot_username: "clinica_bot",
      display_name: "Atendimento",
      token_last4: "6789",
      status: "configured" as "configured" | "active" | "paused" | "disconnected" | "deleted",
      created_at: "2026-10-17T12:00:00Z",
      bindings: [
        { surface: "inbox" as const, capabilities: ["receive_messages", "human_replies"] },
      ],
    };
    const response = async () => ({ data: { bots: bot.status === "deleted" ? [] : [{ ...bot }] } });
    api.get.mockImplementation(response);
    api.patch.mockImplementation(async (_path: string, body: { action?: string }) => {
      const nextStatus = (
        {
          activate: "active",
          pause: "paused",
          reactivate: "active",
          disconnect: "disconnected",
          delete: "deleted",
        } as const
      )[body.action as "activate"];
      if (nextStatus) bot.status = nextStatus;
      return { data: { status: bot.status } };
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TelegramConnectionsClient />);

    await user.click(await screen.findByRole("button", { name: "Ativar" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith("/api/v1/channels/telegram", {
        action: "activate",
        connection_id: "connection-1",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Pausar" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith("/api/v1/channels/telegram", {
        action: "pause",
        connection_id: "connection-1",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Reativar" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith("/api/v1/channels/telegram", {
        action: "reactivate",
        connection_id: "connection-1",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Desconectar" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith("/api/v1/channels/telegram", {
        action: "disconnect",
        connection_id: "connection-1",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Reativar" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith("/api/v1/channels/telegram", {
        action: "reactivate",
        connection_id: "connection-1",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Excluir" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith("/api/v1/channels/telegram", {
        action: "delete",
        connection_id: "connection-1",
      }),
    );
    await screen.findByText("Nenhum bot cadastrado");
    expect(window.confirm).toHaveBeenCalledOnce();
  });

  it("permite editar capacidades com o bot ativo e mantém o fluxo de salvamento", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({
      data: {
        bots: [
          {
            id: "connection-active",
            telegram_bot_id: "123456",
            bot_username: "clinica_bot",
            display_name: "Atendimento",
            token_last4: "6789",
            status: "active",
            created_at: "2026-10-17T12:00:00Z",
            bindings: [
              {
                surface: "inbox",
                capabilities: ["receive_messages", "human_replies", "proactive_send"],
              },
              { surface: "agent_tools", capabilities: ["tool_read"] },
            ],
          },
        ],
      },
    });
    api.patch.mockResolvedValue({ data: { status: "active" } });
    render(<TelegramConnectionsClient />);

    const configure = await screen.findByRole("button", { name: "Configurações do bot" });
    expect(configure).toBeEnabled();
    await user.click(configure);
    await screen.findByRole("dialog");
    const aiReplies = screen.getByRole("checkbox", { name: /Respostas automáticas de IA/ });
    expect(aiReplies).not.toBeChecked();
    await user.click(aiReplies);
    await user.click(screen.getByRole("button", { name: "Salvar configurações" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/channels/telegram", {
        connection_id: "connection-active",
        bindings: [
          { surface: "inbox", capabilities: ["receive_messages", "human_replies", "ai_replies"] },
        ],
      }),
    );
  });

  it("consulta e mostra a saúde real do webhook do bot ativo", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation(async (path: string) =>
      path.endsWith("/health")
        ? {
            data: {
              health: "healthy",
              pending_update_count: 0,
              app_pending_update_count: 2,
              last_error_at: null,
              webhook_matches: true,
              checked_at: "2026-10-19T12:00:00Z",
            },
          }
        : {
            data: {
              bots: [
                {
                  id: "connection-1",
                  telegram_bot_id: "123456",
                  bot_username: "clinica_bot",
                  display_name: "Atendimento",
                  token_last4: "6789",
                  status: "active",
                  created_at: "2026-10-17T12:00:00Z",
                  bindings: [
                    { surface: "inbox", capabilities: ["receive_messages", "human_replies"] },
                  ],
                },
              ],
            },
          },
    );
    render(<TelegramConnectionsClient />);

    await user.click(await screen.findByRole("button", { name: "Verificar webhook" }));
    expect((await screen.findByRole("status")).textContent).toContain("Webhook confirmado");
    expect(api.get).toHaveBeenCalledWith("/api/v1/channels/telegram/connection-1/health");
  });
});
