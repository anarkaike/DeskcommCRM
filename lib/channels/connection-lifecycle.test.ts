import { describe, expect, it, vi } from "vitest";
import { decideConnectionLifecycle, createConnectionLifecycle } from "./connection-lifecycle";
import { ChannelConnectionRegistry } from "./connection-registry";
import type { ChannelConnectionDriver, ChannelConnectionRecord } from "./connection-types";

const record: ChannelConnectionRecord = {
  provider: "telegram",
  status: "configured",
  grants: [{ surface: "inbox", capabilities: ["receive_messages", "human_replies"] }],
};

describe("shared channel connection lifecycle", () => {
  it("requires the configured grants and returns a shared activation decision", () => {
    expect(decideConnectionLifecycle(record, "activate", [
      { surface: "inbox", capability: "receive_messages" },
      { surface: "inbox", capability: "human_replies" },
    ])).toEqual({ allowed: true, nextStatus: "active" });
    expect(decideConnectionLifecycle(record, "activate", [
      { surface: "inbox", capability: "ai_replies" },
    ])).toEqual({ allowed: false, reason: "missing_required_grant" });
  });

  it("rejects invalid state transitions and permits pause only from active", () => {
    expect(decideConnectionLifecycle({ ...record, status: "active" }, "activate").allowed).toBe(false);
    expect(decideConnectionLifecycle(record, "pause")).toEqual({ allowed: false, reason: "invalid_transition" });
    expect(decideConnectionLifecycle({ ...record, status: "deleted" }, "reactivate")).toEqual({ allowed: false, reason: "invalid_transition" });
    expect(decideConnectionLifecycle({ ...record, status: "active" }, "pause")).toEqual({ allowed: true, nextStatus: "paused" });
  });

  it("uses the provider driver only after shared policy accepts the transition", async () => {
    const driver: ChannelConnectionDriver<string> = {
      provider: "telegram",
      validateCredential: vi.fn(async () => ({ providerAccountId: "123" })),
      activate: vi.fn(async () => undefined),
      deactivate: vi.fn(async () => undefined),
      health: vi.fn(async () => ({ healthy: true, checkedAt: new Date(0).toISOString(), state: "connected" as const })),
    };
    const lifecycle = createConnectionLifecycle(driver);
    const context = { organizationId: "org-1", connectionId: "conn-1", actorUserId: "user-1" };
    await expect(lifecycle.activate(context, record, [{ surface: "inbox", capability: "receive_messages" }]))
      .resolves.toEqual({ allowed: true, nextStatus: "active" });
    await expect(lifecycle.deactivate(context, record, "pause"))
      .resolves.toEqual({ allowed: false, reason: "invalid_transition" });
    expect(driver.activate).toHaveBeenCalledOnce();
    expect(driver.deactivate).not.toHaveBeenCalled();
  });

  it("registers one driver per provider and fails closed for unknown providers", () => {
    const driver: ChannelConnectionDriver<null> = {
      provider: "telegram", validateCredential: async () => null,
      activate: async () => undefined, deactivate: async () => undefined,
      health: async () => ({ healthy: false, checkedAt: new Date(0).toISOString(), state: "unknown" }),
    };
    const registry = new ChannelConnectionRegistry().register(driver);
    expect(registry.providers()).toEqual(["telegram"]);
    expect(registry.get("telegram").provider).toBe("telegram");
    expect(() => registry.register(driver)).toThrow("duplicate_channel_connection_driver");
    expect(() => registry.get("meta_cloud")).toThrow("unknown_channel_connection_driver");
  });
});\n