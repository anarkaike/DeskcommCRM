import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  role: vi.fn(),
  requireSupportWrite: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.requireSupportWrite }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ connect: h.connect }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { PUT } from "./route";

const params = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };

describe("Telegram group settings API", () => {
  beforeEach(() => {
    h.role.mockReset().mockResolvedValue({
      ok: true,
      org: { orgId: "org-1" },
      user: { id: "user-1" },
    });
    h.requireSupportWrite.mockReset().mockResolvedValue(null);
    h.connect.mockReset();
  });

  it("enables the read-only assistant only after group and operator safety checks", async () => {
    const queries = [
      { rows: [] }, // begin
      { rows: [{ id: "bot-1", status: "active", channel_session_id: "session-1" }] },
      { rows: [{ id: "session-group-1" }] },
      { rows: [{ surface: "human_cases", capability: "read_cases" }] },
      { rows: [{ id: "group-setting-1", membership_state: "healthy", membership_attested_at: "2026-10-26T12:00:00Z", case_actions_enabled: false, team_assistant_enabled: false }] },
      { rows: [{ id: 1 }], rowCount: 1 }, // reviewed active paired operator
      { rows: [], rowCount: 1 }, // update settings
      { rows: [] }, // commit
    ];
    const clientQuery = vi.fn(async () => queries.shift() ?? { rows: [], rowCount: 1 });
    h.connect.mockResolvedValue({ query: clientQuery, release: vi.fn() });
    const response = await PUT(
      new NextRequest("https://crm.example/api/v1/channels/telegram/bot-1/groups", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group_chat_id: "-1001234567890",
          team_assistant_enabled: true,
        }),
      }),
      params,
    );
    expect(response.status).toBe(200);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("m.can_use_assistant=true"), ["11111111-1111-4111-8111-111111111111", "org-1", "group-setting-1"]);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("team_assistant_enabled=coalesce"), expect.any(Array));
  });

  it("keeps the assistant disabled if no reviewed operator is eligible", async () => {
    const queries = [
      { rows: [] },
      { rows: [{ id: "bot-1", status: "active", channel_session_id: "session-1" }] },
      { rows: [{ id: "session-group-1" }] },
      { rows: [{ surface: "human_cases", capability: "read_cases" }] },
      { rows: [{ id: "group-setting-1", membership_state: "healthy", membership_attested_at: "2026-10-26T12:00:00Z", case_actions_enabled: false, team_assistant_enabled: false }] },
      { rows: [], rowCount: 0 },
    ];
    const clientQuery = vi.fn(async () => queries.shift() ?? { rows: [] });
    h.connect.mockResolvedValue({ query: clientQuery, release: vi.fn() });
    const response = await PUT(
      new NextRequest("https://crm.example/api/v1/channels/telegram/bot-1/groups", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group_chat_id: "-1001234567890", team_assistant_enabled: true }),
      }),
      params,
    );
    expect(response.status).toBe(409);
    expect(clientQuery).toHaveBeenCalledWith("rollback");
    expect(clientQuery).not.toHaveBeenCalledWith(expect.stringContaining("team_assistant_enabled=coalesce"), expect.any(Array));
  });
});
