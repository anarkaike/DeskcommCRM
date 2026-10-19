import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  connection: {
    id: "connection-1",
    status: "active",
    token_encrypted: "ciphertext",
    webhook_path_token: "path-secret-123456789012345678901234567890",
  },
  role: vi.fn(),
  decrypt: vi.fn(),
  webhookInfo: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: h.decrypt }));
vi.mock("@/lib/webhooks/url-publica", () => ({ basePublicaDaInstalacao: () => "https://crm.example" }));
vi.mock("@/lib/channels/telegram/bot-api", () => ({ getTelegramWebhookInfo: h.webhookInfo }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: h.connection, error: null }),
      };
      return q;
    },
  }),
}));

import { GET } from "./route";

describe("Telegram webhook health route", () => {
  beforeEach(() => {
    h.role.mockReset().mockResolvedValue({ ok: true, org: { orgId: "org-1" }, user: { id: "user-1" } });
    h.decrypt.mockReset().mockResolvedValue("server-token");
    h.webhookInfo.mockReset().mockResolvedValue({
      url: "https://crm.example/api/v1/webhooks/telegram/path-secret-123456789012345678901234567890",
      pendingUpdateCount: 2,
      lastErrorDate: null,
      lastErrorMessage: null,
      hasCustomCertificate: false,
      maxConnections: 40,
      allowedUpdates: ["message"],
    });
  });

  it("confirms the configured endpoint without returning its secret URL", async () => {
    const response = await GET(
      new NextRequest("https://crm.example/api/v1/channels/telegram/connection-1/health"),
      { params: Promise.resolve({ id: "connection-1" }) },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ health: "healthy", pending_update_count: 2, webhook_matches: true });
    expect(JSON.stringify(body)).not.toContain("path-secret");
  });

  it("reports a webhook that points elsewhere as degraded", async () => {
    h.webhookInfo.mockResolvedValueOnce({
      url: "https://wrong.example/hook",
      pendingUpdateCount: 0,
      lastErrorDate: null,
      lastErrorMessage: null,
      hasCustomCertificate: false,
      maxConnections: null,
      allowedUpdates: [],
    });
    const response = await GET(
      new NextRequest("https://crm.example/api/v1/channels/telegram/connection-1/health"),
      { params: Promise.resolve({ id: "connection-1" }) },
    );
    expect((await response.json()).data).toMatchObject({ health: "degraded", webhook_matches: false });
  });
});
