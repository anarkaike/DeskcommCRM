import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  role: vi.fn(),
  supportWrite: vi.fn(),
  query: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.supportWrite }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: h.query }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: h.maybeSingle,
      };
      return chain;
    },
    rpc: h.rpc,
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { GET, PUT } from "./route";

const request = (body: unknown) =>
  new NextRequest("https://crm.example/api/v1/ai/cases/telegram-destination", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Telegram case alert destination API", () => {
  beforeEach(() => {
    h.role.mockReset().mockResolvedValue({
      ok: true,
      org: { orgId: "org-1" },
      user: { id: "user-1" },
    });
    h.supportWrite.mockReset().mockResolvedValue(null);
    h.query.mockReset().mockResolvedValue({
      rows: [{
        group_setting_id: "11111111-1111-4111-8111-111111111111",
        group_chat_id: "-1001234567890",
        subject: "Equipe de QA",
        connection_id: "connection-1",
        bot_name: "Bot QA",
        bot_username: "qa_bot",
        membership_state: "healthy",
        case_alerts_enabled: true,
        eligible: true,
      }],
    });
    h.maybeSingle.mockReset().mockResolvedValue({
      data: { destino_tipo: "telegram", telegram_group_setting_id: "11111111-1111-4111-8111-111111111111" },
      error: null,
    });
    h.rpc.mockReset().mockResolvedValue({ data: true, error: null });
    h.audit.mockReset().mockResolvedValue(undefined);
  });

  it("reads eligible groups and the canonical selected destination in the organization", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining("t.organization_id=$1"), ["org-1"]);
    expect(body.data).toMatchObject({
      group_setting_id: "11111111-1111-4111-8111-111111111111",
      destination_type: "telegram",
      groups: [{ group_setting_id: "11111111-1111-4111-8111-111111111111", eligible: true }],
    });
  });

  it("writes through the canonical RPC and audits the change", async () => {
    const response = await PUT(request({
      group_setting_id: "11111111-1111-4111-8111-111111111111",
    }));

    expect(response.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("fn_definir_aviso_de_caso_telegram", {
      p_org: "org-1",
      p_group_setting_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.case_alert_settings_changed",
      organizationId: "org-1",
      metadata: { destination_type: "telegram", destination_configured: true },
    }));
  });

  it("rejects unexpected fields instead of silently accepting a second config", async () => {
    const response = await PUT(request({
      group_setting_id: null,
      whatsapp_phone: "+5511999999999",
    }));

    expect(response.status).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("returns a conflict when the selected group is no longer eligible", async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "telegram_case_alert_group_ineligible" },
    });
    const response = await PUT(request({
      group_setting_id: "11111111-1111-4111-8111-111111111111",
    }));

    expect(response.status).toBe(409);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
