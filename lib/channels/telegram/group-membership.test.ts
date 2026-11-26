import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleTelegramGroupMembershipUpdate,
  normalizeTelegramId,
  normalizeTelegramMembershipStatus,
} from "./group-membership";

describe("Telegram group membership normalization", () => {
  it("preserves Telegram identifiers represented as strings", () => {
    expect(normalizeTelegramId("-1001234567890123")).toBe("-1001234567890123");
    expect(normalizeTelegramId("98765432101234567890")).toBe("98765432101234567890");
  });
  it("rejects malformed or unsafe identifiers instead of authorizing a rounded identity", () => {
    expect(normalizeTelegramId(9007199254740992)).toBeNull();
    expect(normalizeTelegramId("1e9")).toBeNull();
    expect(normalizeTelegramId("-")).toBeNull();
  });
  it("maps only explicit Telegram membership states", () => {
    expect(normalizeTelegramMembershipStatus("member")).toBe("member");
    expect(normalizeTelegramMembershipStatus("administrator")).toBe("member");
    expect(normalizeTelegramMembershipStatus("left")).toBe("left");
    expect(normalizeTelegramMembershipStatus("kicked")).toBe("left");
    expect(normalizeTelegramMembershipStatus("restricted")).toBe("restricted");
    expect(normalizeTelegramMembershipStatus("unknown-status")).toBe("unknown");
  });
});

const { query, connect } = vi.hoisted(() => {
  const query = vi.fn();
  const connect = vi.fn(async () => ({ query, release: vi.fn() }));
  return { query, connect };
});
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ connect }),
}));

describe("group message membership observation", () => {
  beforeEach(() => {
    connect.mockClear();
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("from public.channel_sessions")) return { rows: [{ id: "session-1" }] };
      if (sql.includes("insert into public.channel_session_groups"))
        return { rows: [{ id: "group-1" }] };
      if (sql.includes("insert into public.telegram_team_group_settings")) {
        return { rows: [{ id: "setting-1", membership_last_update_id: null }] };
      }
      if (sql.includes("from public.telegram_team_group_members")) return { rows: [] };
      if (sql.includes("from public.telegram_case_operators")) return { rows: [] };
      return { rows: [] };
    });
  });

  it("discovers a message sender, suspends an unreviewed group, then continues the Inbox flow", async () => {
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              }),
            }),
          }),
        }),
      }),
    } as never;
    const handled = await handleTelegramGroupMembershipUpdate(admin, {
      organizationId: "org-1",
      connectionId: "connection-1",
      update: {
        update_id: 42,
        message: {
          chat: { id: -1001234567890, type: "supergroup", title: "QA" },
          from: { id: 10001, is_bot: false, first_name: "June", username: "june" },
        },
      },
    });
    expect(handled).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("insert into public.telegram_team_group_members"),
      ),
    ).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("unknown_member_observed"))).toBe(
      true,
    );
    expect(query.mock.calls.some(([sql]) => String(sql) === "commit")).toBe(true);
    const reviewCallbacks = query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into public.telegram_case_interactions"),
    );
    expect(reviewCallbacks?.[0]).toContain("'approve_member'");
    expect(reviewCallbacks?.[0]).toContain("'deny_member'");
    expect(reviewCallbacks?.[0]).toContain("target_telegram_user_id");
  });

  it("does not consume private messages before Telegram Inbox ingestion", async () => {
    const handled = await handleTelegramGroupMembershipUpdate({} as never, {
      organizationId: "org-1",
      connectionId: "connection-1",
      update: {
        update_id: 44,
        message: {
          chat: { id: 10001, type: "private" },
          from: { id: 10001, is_bot: false, first_name: "June" },
          text: "A private support question",
        },
      },
    });
    expect(handled).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it("ignores group messages sent by bots for membership grants without consuming the Inbox update", async () => {
    const handled = await handleTelegramGroupMembershipUpdate({} as never, {
      organizationId: "org-1",
      connectionId: "connection-1",
      update: {
        update_id: 43,
        message: {
          chat: { id: -1001234567890, type: "supergroup", title: "QA" },
          from: { id: 999, is_bot: true, first_name: "Bot" },
        },
      },
    });
    expect(handled).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
});
