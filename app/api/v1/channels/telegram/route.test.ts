import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(async () => ({
  ok: true, user: { id: "33333333-3333-4333-8333-333333333333" },
  org: { orgId: "11111111-1111-4111-8111-111111111111" },
})) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { PATCH } from "./route";

function request(bindings: unknown[]) {
  return new NextRequest("http://localhost/api/v1/channels/telegram", {
    method: "PATCH", body: JSON.stringify({ connection_id: CONNECTION, bindings }),
  });
}

describe("configurações editáveis do Telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.from.mockImplementation((table: string) => {
      const data = table === "telegram_bot_connections" ? { status: "active" }
        : table === "telegram_bot_bindings" ? [{ surface: "inbox" }, { surface: "agent_tools" }]
        : [{ surface: "inbox", capability: "proactive_send" }, { surface: "agent_tools", capability: "tool_read" }];
      const chain = {
        select: vi.fn(() => chain), eq: vi.fn(() => chain), is: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({ data, error: null })),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
      };
      return chain;
    });
  });

  it("salva no bot ativo e preserva capacidades e superfícies fora do formulário", async () => {
    const response = await PATCH(request([{ surface: "inbox", capabilities: ["receive_messages", "human_replies"] }]));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_telegram_bot_save_bindings", expect.objectContaining({
      p_organization_id: ORG, p_connection_id: CONNECTION,
      p_bindings: [
        { surface: "inbox", capabilities: ["receive_messages", "human_replies", "proactive_send"] },
        { surface: "agent_tools", capabilities: ["tool_read"] },
      ],
    }));
  });

  it("recusa concessão de capacidades não editáveis enviada pelo cliente", async () => {
    const response = await PATCH(request([{ surface: "inbox", capabilities: ["receive_messages", "proactive_send"] }]));
    expect(response.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
