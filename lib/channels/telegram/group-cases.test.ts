import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramGroupCaseUpdate } from "./group-cases";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  send: vi.fn(),
  answer: vi.fn(),
  decrypt: vi.fn(),
  audit: vi.fn(),
  resolve: vi.fn(),
  ask: vi.fn(),
  enqueue: vi.fn(),
  assistant: vi.fn(),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mocks.query, connect: mocks.connect }),
}));
vi.mock("@/lib/channels/telegram/bot-api", () => ({
  sendTelegramText: mocks.send,
  answerTelegramCallbackQuery: mocks.answer,
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: mocks.decrypt }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/agent-engine/agent/human-cases", () => ({
  resolveCaseFromHuman: mocks.resolve,
  markAwaitingLead: mocks.ask,
}));
vi.mock("@/lib/agent-engine/queue/queue", () => ({ enqueueJob: mocks.enqueue }));
vi.mock("@/lib/agent-engine/agent/conversa-do-caso", () => ({ responderSobreOCaso: mocks.assistant }));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({ llmEdgeConfigFromEnv: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/env", () => ({ loadEnv: vi.fn(() => ({})) }));

const org = "11111111-1111-4111-8111-111111111111";
const connection = "22222222-2222-4222-8222-222222222222";
const group = "33333333-3333-4333-8333-333333333333";
const caseId = "44444444-4444-4444-8444-444444444444";
const interactionId = "55555555-5555-4555-8555-555555555555";
const callback = (data = "opaque_callback") => ({
  update_id: 987,
  callback_query: {
    id: "callback-id",
    data,
    from: { id: 987654321 },
    message: { message_id: 42, chat: { id: "-100123456789", type: "supergroup" } },
  },
});
const admin = {
  from: () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.is = () => q;
    q.maybeSingle = async () => ({ data: { token_encrypted: "ciphertext" }, error: null });
    return q;
  },
} as never;

describe("Telegram human case group callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockResolvedValue("bot-token");
    mocks.answer.mockResolvedValue(undefined);
    mocks.send.mockResolvedValue({ messageId: "88", chatId: "-100123456789", date: 1 });
    mocks.assistant.mockResolvedValue({ texto: "O caso aguarda retorno humano.", callId: "llm-1", agentId: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("lets ordinary group messages fall through to the allowlisted inbox adapter", async () => {
    const result = await handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: {
        update_id: 123,
        message: {
          message_id: 9,
          text: "Conseguimos ajudar com esse caso?",
          chat: { id: "-100123456789", type: "supergroup" },
          from: { id: 987654321 },
        },
      },
    });
    expect(result).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("acknowledges replay of a completed case reply without ingesting it into Inbox", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes("i.update_id=$4 and i.status=$5")
        ? { rows: [{ id: interactionId }] }
        : { rows: [] },
    );
    const result = await handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: {
        update_id: 125,
        message: {
          message_id: 11,
          text: "confirmed guidance",
          chat: { id: "-100123456789", type: "supergroup" },
          from: { id: 987654321 },
          reply_to_message: { message_id: 88 },
        },
      },
    });
    expect(result).toBe(true);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("i.update_id=$4 and i.status=$5"),
      [org, connection, "-100123456789", 125, "completed"],
    );
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("lets a reply to an unrelated group message fall through without case action", async () => {
    mocks.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ id: group }] }),
      release: vi.fn(),
    });
    mocks.query.mockResolvedValue({ rows: [] });
    const result = await handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: {
        update_id: 124,
        message: {
          message_id: 10,
          text: "Minha sugestão é perguntar qual escola.",
          chat: { id: "-100123456789", type: "supergroup" },
          from: { id: 987654321 },
          reply_to_message: { message_id: 8 },
        },
      },
    });
    expect(result).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("lists only tenant-scoped open cases and creates one-use view callbacks", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select i.id::text"))
        return {
          rows: [
            {
              id: interactionId,
              organization_id: org,
              connection_id: connection,
              group_setting_id: group,
              case_id: null,
              action: "list_open",
              telegram_user_id: "0",
              actor_user_id: null,
              group_message_id: "42",
            },
          ],
        };
      if (sql.includes("select o.id::text"))
        return { rows: [{ id: "operator", user_id: "user-1" }] };
      if (sql.includes("update telegram_case_interactions set status='completed'"))
        return { rowCount: 1, rows: [{ id: interactionId }] };
      if (sql.includes("select id::text,title from agent_cases"))
        return { rows: [{ id: caseId, title: "Pedido de uniforme" }] };
      return { rowCount: 1, rows: [] };
    });
    await expect(
      handleTelegramGroupCaseUpdate(admin, {
        organizationId: org,
        connectionId: connection,
        update: callback(),
      }),
    ).resolves.toBe(true);
    const listQuery = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("select id::text,title from agent_cases"),
    );
    expect(listQuery?.[1]).toEqual([org, ["awaiting_human", "awaiting_lead"]]);
    const actorAuthorization = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("select o.id::text"),
    )?.[0] as string;
    expect(actorAuthorization).toContain("m.can_read_cases=true");
    expect(actorAuthorization).toContain("m.can_act_on_cases=true");
    expect(actorAuthorization).toContain("$5::text='read' or $5::text='approve' or g.case_actions_enabled=true");
    expect(actorAuthorization).toContain("c.capability='read_cases'");
    expect(actorAuthorization).toContain("c.capability='reply_to_cases'");
    const actorAuthorizationParams = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("select o.id::text"),
    )?.[1];
    expect(actorAuthorizationParams).toEqual([org, connection, group, "987654321", "read"]);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "-100123456789",
        text: expect.stringContaining("Casos abertos"),
        inlineKeyboard: [
          [
            expect.objectContaining({
              text: expect.stringContaining(caseId.slice(0, 8)),
              callbackData: expect.any(String),
            }),
          ],
        ],
      }),
    );
    const insert = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into telegram_case_interactions"),
    );
    expect(insert?.[1]).toEqual(
      expect.arrayContaining([org, connection, group, caseId, "view_case"]),
    );
  });

  it("denies an unpaired operator before querying or exposing case data", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select i.id::text"))
        return {
          rows: [
            {
              id: interactionId,
              organization_id: org,
              connection_id: connection,
              group_setting_id: group,
              case_id: null,
              action: "list_open",
              telegram_user_id: "0",
              actor_user_id: null,
              group_message_id: "42",
            },
          ],
        };
      if (sql.includes("select o.id::text")) return { rows: [] };
      return { rowCount: 0, rows: [] };
    });
    await handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: callback(),
    });
    expect(mocks.answer).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Sua conta não tem permissão para agir neste caso." }),
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes("select id::text,title from agent_cases"),
      ),
    ).toBe(false);
  });

  it("lets an authorized operator inspect a closed case read-only", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select i.id::text"))
        return {
          rows: [
            {
              id: interactionId,
              organization_id: org,
              connection_id: connection,
              group_setting_id: group,
              case_id: caseId,
              action: "view_case",
              telegram_user_id: "0",
              actor_user_id: null,
              group_message_id: "42",
            },
          ],
        };
      if (sql.includes("select o.id::text"))
        return { rows: [{ id: "operator", user_id: "user-1" }] };
      if (sql.includes("select title,status from agent_cases"))
        return { rows: [{ title: "Caso encerrado", status: "resolved" }] };
      if (sql.includes("update telegram_case_interactions set status='completed'"))
        return { rowCount: 1, rows: [{ id: interactionId }] };
      return { rowCount: 1, rows: [] };
    });
    await handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: callback(),
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Consulta somente leitura.") }),
    );
    expect(mocks.send.mock.calls[0]?.[0]).not.toHaveProperty("inlineKeyboard");
    const actorAuthorization = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("select o.id::text"),
    );
    expect(actorAuthorization?.[1]).toEqual([org, connection, group, "987654321", "read"]);
  });

  it("requires the separate action grant and reply capability for case mutations", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select i.id::text"))
        return {
          rows: [
            {
              id: interactionId,
              organization_id: org,
              connection_id: connection,
              group_setting_id: group,
              case_id: caseId,
              action: "guide_reply",
              telegram_user_id: "0",
              actor_user_id: null,
              group_message_id: "42",
            },
          ],
        };
      if (sql.includes("select o.id::text")) return { rows: [] };
      return { rowCount: 0, rows: [] };
    });
    await handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: callback(),
    });
    const authorization = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("select o.id::text"),
    );
    expect(authorization?.[0]).toContain("m.can_act_on_cases=true");
    expect(authorization?.[0]).toContain("c.capability='reply_to_cases'");
    expect(authorization?.[1]).toEqual([org, connection, group, "987654321", "act"]);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.answer).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Sua conta não tem permissão para agir neste caso." }),
    );
  });

  it("answers a verified operator's direct reply to a case card with read-only case context", async () => {
    mocks.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ id: group }] }),
      release: vi.fn(),
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("i.update_id=$4 and i.status=$5")) return { rows: [] };
      if (sql.includes("select i.id::text interaction_id"))
        return { rows: [{
          interaction_id: interactionId,
          case_id: caseId,
          contact_id: "contact-1",
          title: "Pedido do cliente",
          kind: "Uniforme escolar",
          status: "awaiting_human",
          summary: "A escola informou o prazo de entrega.",
          blocker: null,
        }] };
      if (sql.includes("insert into telegram_case_interactions")) return { rows: [{ id: "assistant-interaction" }] };
      if (sql.includes("select paired_user_id::text user_id")) return { rows: [{ user_id: "operator-1" }] };
      return { rows: [], rowCount: 1 };
    });

    const handled = await handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: {
        update_id: 126,
        message: {
          message_id: 12,
          text: "Qual é o prazo que a escola informou?",
          chat: { id: "-100123456789", type: "supergroup" },
          from: { id: 987654321 },
          reply_to_message: { message_id: 88 },
        },
      },
    });

    expect(handled).toBe(true);
    expect(mocks.assistant).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        tenantId: org,
        contactId: "contact-1",
        pergunta: "Qual é o prazo que a escola informou?",
        blocoDeDados: expect.stringContaining("A escola informou o prazo de entrega."),
        historico: [],
      }),
    );
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "-100123456789",
      text: "O caso aguarda retorno humano.",
      replyToMessageId: "12",
    }));
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "telegram.team_group_assistant_replied",
      resourceId: caseId,
    }));
  });

  it("lets a separately authorized paired operator approve an unknown member without case-read access", async () => {
    const transactionQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("update telegram_team_group_members")) return { rowCount: 1, rows: [{ telegram_user_id: "2222" }] };
      if (sql.includes("update telegram_case_interactions set status='completed'")) return { rowCount: 1, rows: [{ id: interactionId }] };
      return { rowCount: 1, rows: [] };
    });
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query: transactionQuery, release });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select i.id::text")) return { rows: [{
        id: interactionId, organization_id: org, connection_id: connection,
        group_setting_id: group, case_id: null, target_telegram_user_id: "2222",
        action: "approve_member", telegram_user_id: "0", actor_user_id: null,
        group_message_id: "42",
      }] };
      if (sql.includes("select o.id::text")) return { rows: [{ id: "operator", user_id: "user-1" }] };
      return { rowCount: 1, rows: [] };
    });

    await expect(handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: callback(),
    })).resolves.toBe(true);

    const authorization = mocks.query.mock.calls.find(([sql]) => String(sql).includes("select o.id::text"));
    expect(authorization?.[0]).toContain("$5::text='approve' or m.can_read_cases=true");
    expect(authorization?.[1]).toEqual([org, connection, group, "987654321", "approve"]);
    expect(transactionQuery.mock.calls.map(([sql]) => String(sql))).toEqual(expect.arrayContaining([
      "begin",
      expect.stringContaining("approval_state=$5"),
      expect.stringContaining("set status='completed'"),
      "commit",
    ]));
    expect(transactionQuery.mock.calls[1]?.[1]).toEqual([org, group, "2222", "user-1", "observer"]);
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "telegram.team_group_settings_updated",
      metadata: expect.objectContaining({ decision: "observer", target_telegram_user_id: "2222" }),
    }));
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("somente como observador"),
    }));
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a delivered assistant reply completed when audit storage fails", async () => {
    mocks.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ id: group }] }),
      release: vi.fn(),
    });
    mocks.audit.mockRejectedValue(new Error("audit temporarily unavailable"));
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("i.update_id=$4 and i.status=$5")) return { rows: [] };
      if (sql.includes("select i.id::text interaction_id"))
        return { rows: [{
          interaction_id: interactionId,
          case_id: caseId,
          contact_id: "contact-1",
          title: "Pedido do cliente",
          kind: "Uniforme escolar",
          status: "awaiting_human",
          summary: "A escola informou o prazo de entrega.",
          blocker: null,
        }] };
      if (sql.includes("insert into telegram_case_interactions")) return { rows: [{ id: "assistant-interaction" }] };
      if (sql.includes("select paired_user_id::text user_id")) return { rows: [{ user_id: "operator-1" }] };
      return { rows: [], rowCount: 1 };
    });

    await expect(handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: {
        update_id: 128,
        message: {
          message_id: 14,
          text: "Qual e o prazo?",
          chat: { id: "-100123456789", type: "supergroup" },
          from: { id: 987654321 },
          reply_to_message: { message_id: 88 },
        },
      },
    })).resolves.toBe(true);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("set status='completed',group_message_id=$3"),
    )).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("set status='rejected',consumed_at=now()"),
    )).toBe(false);
  });

  it("does not invoke the assistant when a reply is not linked to a case card", async () => {
    mocks.connect.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ id: group }] }),
      release: vi.fn(),
    });
    mocks.query.mockResolvedValue({ rows: [] });
    const handled = await handleTelegramGroupCaseUpdate(admin, {
      organizationId: org,
      connectionId: connection,
      update: {
        update_id: 127,
        message: {
          message_id: 13,
          text: "O prazo é de duas semanas.",
          chat: { id: "-100123456789", type: "supergroup" },
          from: { id: 987654321 },
          reply_to_message: { message_id: 88 },
        },
      },
    });
    expect(handled).toBe(false);
    expect(mocks.assistant).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
