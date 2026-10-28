import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  admin: vi.fn(),
  decrypt: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mocks.query, connect: mocks.connect }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: mocks.decrypt }));
vi.mock("@/lib/channels/telegram/bot-api", () => ({ sendTelegramText: mocks.send }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example" } }));

import { telegramCaseAlertHandler } from "./telegram-case-alert.handler";

const org = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const groupSettingId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
const destination = {
  group_setting_id: groupSettingId,
  connection_id: connectionId,
  group_chat_id: "-1001234567890",
  display_name: "QA",
};
const event = {
  id: "event-1",
  organization_id: org,
  event_type: "ai.case_opened",
  entity_kind: "agent_case",
  entity_id: caseId,
  payload: { case_id: caseId },
  metadata: {},
  consumed_by: [],
  attempts: 0,
};

function makeAdmin() {
  return {
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.is = () => q;
      q.maybeSingle = async () => ({ data: { token_encrypted: "encrypted" }, error: null });
      return q;
    },
  };
}

function makeClient(priorStatus?: string) {
  const clientQuery = vi.fn(async (sql: string) => {
    if (sql.includes("select d.id::text,d.status"))
      return {
        rows: priorStatus
          ? [{
              id: "delivery-1",
              status: priorStatus,
              updated_at: new Date().toISOString(),
              ...destination,
            }]
          : [],
      };
    if (sql.includes("insert into telegram_case_alert_deliveries"))
      return { rows: [{ id: "delivery-1" }] };
    if (sql.includes("select (t.case_alerts_enabled=true")) return { rows: [{ ok: true }] };
    if (sql.includes("update telegram_case_alert_deliveries set status=sending"))
      return { rowCount: 1, rows: [{ id: "delivery-1" }] };
    return { rows: [], rowCount: 1 };
  });
  const client = { query: clientQuery, release: vi.fn() };
  mocks.connect.mockResolvedValue(client);
  return client;
}

describe("Telegram case alert event handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admin.mockReturnValue(makeAdmin());
    mocks.decrypt.mockResolvedValue("telegram-token");
    mocks.send.mockResolvedValue({ messageId: "telegram-message-99", chatId: destination.group_chat_id, date: 1 });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select t.id::text group_setting_id")) return { rows: [destination] };
      if (sql.includes("select status from agent_cases")) return { rows: [{ status: "awaiting_human" }] };
      return { rows: [], rowCount: 1 };
    });
  });

  it("sends one minimal, idempotently recorded group alert with explicit case actions", async () => {
    const client = makeClient();
    const result = await telegramCaseAlertHandler.handle(event as never);
    expect(result).toMatchObject({ status: "ok", detail: "telegram_case_alert_sent" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      token: "telegram-token",
      chatId: destination.group_chat_id,
      text: expect.stringContaining(caseId.slice(0, 8)),
      inlineKeyboard: expect.arrayContaining([
        expect.arrayContaining([expect.objectContaining({ text: "Orientar resposta ao cliente" })]),
        expect.arrayContaining([expect.objectContaining({ text: "Ver casos abertos" })]),
      ]),
    }));
    const body = mocks.send.mock.calls.at(0)?.[0]?.text ?? "";
    const bodyWithoutLinks = body.replace(/https?:\/\/\S+/g, "");
    expect(bodyWithoutLinks).not.toMatch(/\+?\d{10,}/);
    expect(body).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(body).not.toContain("context_snapshot");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into telegram_case_alert_deliveries"),
      [org, caseId, groupSettingId, connectionId],
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("update telegram_case_alert_deliveries set status='sent',message_id=$2"),
      ["delivery-1", "telegram-message-99"],
    );
  });

  it("does not send a second alert after the existing delivery is sent", async () => {
    makeClient("sent");
    const result = await telegramCaseAlertHandler.handle(event as never);
    expect(result).toMatchObject({ status: "skipped", detail: "telegram_case_alert_already_delivered" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not alert when the case has already left the human-waiting state", async () => {
    makeClient();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select t.id::text group_setting_id")) return { rows: [destination] };
      if (sql.includes("select status from agent_cases")) return { rows: [{ status: "resolved" }] };
      return { rows: [], rowCount: 1 };
    });
    const result = await telegramCaseAlertHandler.handle(event as never);
    expect(result).toMatchObject({ status: "skipped", detail: "case_no_longer_awaiting_human" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("skips cleanly when no Telegram destination is configured", async () => {
    makeClient();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select t.id::text group_setting_id")) return { rows: [] };
      if (sql.includes("select status from agent_cases")) return { rows: [{ status: "awaiting_human" }] };
      return { rows: [], rowCount: 1 };
    });
    const result = await telegramCaseAlertHandler.handle(event as never);
    expect(result).toMatchObject({ status: "skipped", detail: "telegram_case_alert_not_configured" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
