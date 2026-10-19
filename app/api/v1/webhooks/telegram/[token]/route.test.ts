import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  connection: {
    id: "connection-1",
    organization_id: "org-1",
    status: "active",
    webhook_secret_encrypted: "ciphertext",
  } as Record<string, unknown> | null,
  insertError: null as { code: string; message: string } | null,
  inserts: [] as Array<Record<string, unknown>>,
  secret: "secret-test-token",
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const query: Record<string, unknown> = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: table === "telegram_bot_connections" ? h.connection : null, error: null }),
        insert: async (row: Record<string, unknown>) => {
          h.inserts.push(row);
          return { error: h.insertError };
        },
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => h.secret }));

import { POST } from "./route";

function request(body: string, headers: Record<string, string> = { "x-telegram-bot-api-secret-token": h.secret }) {
  return POST(
    new NextRequest("https://crm.example/api/v1/webhooks/telegram/01234567890123456789012345678901", {
      method: "POST",
      body,
      headers,
    }),
    { params: Promise.resolve({ token: "01234567890123456789012345678901" }) },
  );
}

beforeEach(() => {
  h.connection = {
    id: "connection-1",
    organization_id: "org-1",
    status: "active",
    webhook_secret_encrypted: "ciphertext",
  };
  h.insertError = null;
  h.inserts = [];
  h.secret = "secret-test-token";
});

describe("webhook Telegram", () => {
  it("recusa segredo incorreto sem persistir o payload", async () => {
    const response = await request('{"update_id":12}', { "x-telegram-bot-api-secret-token": "wrong" });
    expect(response.status).toBe(401);
    expect(h.inserts).toEqual([]);
  });

  it("persiste o update sob a organização do bot e retorna aceito", async () => {
    const response = await request('{"update_id":12,"message":{"text":"oi"}}');
    expect(response.status).toBe(200);
    expect(h.inserts).toEqual([{
      organization_id: "org-1",
      connection_id: "connection-1",
      update_id: 12,
      update_type: "message",
      payload: { update_id: 12, message: { text: "oi" } },
      status: "pending",
    }]);
  });

  it("confirma update duplicado sem inserir novamente", async () => {
    h.insertError = { code: "23505", message: "duplicate" };
    const response = await request('{"update_id":12,"message":{"text":"oi"}}');
    expect(response.status).toBe(200);
    expect(h.inserts).toHaveLength(1);
  });

  it("não recebe mensagens quando a conexão está pausada", async () => {
    h.connection = { ...h.connection!, status: "paused" };
    const response = await request('{"update_id":12}');
    expect(response.status).toBe(200);
    expect(h.inserts).toEqual([]);
  });
});
