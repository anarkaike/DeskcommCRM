import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  connection: {
    id: "connection-1",
    organization_id: "org-1",
    status: "active",
    webhook_secret_encrypted: "encrypted-secret",
  } as Record<string, unknown> | null,
  lookupError: null as { message: string } | null,
  insertError: null as { message: string } | null,
  upsert: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            maybeSingle: async () => ({ data: h.connection, error: h.lookupError }),
          }),
        }),
      }),
      upsert: (...args: unknown[]) => {
        h.upsert(...args);
        return Promise.resolve({ error: h.insertError });
      },
    }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: h.decrypt,
}));

import { POST } from "./route";

const token = "path_secret_123456789012345678901234";
const secret = "secret-value-for-test";

function request(body: string, suppliedSecret = secret) {
  return new NextRequest(`https://crm.example/api/v1/webhooks/telegram/${token}`, {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": suppliedSecret },
    body,
  });
}

describe("Telegram webhook receiver", () => {
  beforeEach(() => {
    h.connection = {
      id: "connection-1",
      organization_id: "org-1",
      status: "active",
      webhook_secret_encrypted: "encrypted-secret",
    };
    h.lookupError = null;
    h.insertError = null;
    h.upsert.mockReset();
    h.decrypt.mockReset().mockResolvedValue(secret);
  });

  it("authenticates and persists the update idempotently", async () => {
    const response = await POST(
      request(JSON.stringify({ update_id: 42, message: { text: "oi" } })),
      { params: Promise.resolve({ token }) },
    );

    expect(response.status).toBe(200);
    expect(h.upsert).toHaveBeenCalledWith({
      organization_id: "org-1",
      connection_id: "connection-1",
      update_id: 42,
      update_type: "message",
      payload: { update_id: 42, message: { text: "oi" } },
      status: "pending",
    }, { onConflict: "connection_id,update_id", ignoreDuplicates: true });
  });


  it.each(["callback_query", "chat_member", "my_chat_member"] as const)("persists %s updates for the team runtime", async (kind) => {
    const response = await POST(
      request(JSON.stringify({ update_id: 43, [kind]: { id: 1 } })),
      { params: Promise.resolve({ token }) },
    );
    expect(response.status).toBe(200);
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ update_type: kind }), {
      onConflict: "connection_id,update_id", ignoreDuplicates: true,
    });
  });

  it("rejects a bad secret without persisting", async () => {
    const response = await POST(request(JSON.stringify({ update_id: 42 }), "wrong"), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(401);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body without reading it", async () => {
    const req = request("{}");
    req.headers.set("content-length", "1000001");
    const response = await POST(req, { params: Promise.resolve({ token }) });
    expect(response.status).toBe(413);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("cancels a chunked body as soon as its bytes exceed the limit", async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(encoder.encode("é".repeat(300_000)));
      },
      cancel,
    }, { highWaterMark: 0 });
    const req = request("{}");
    Object.defineProperty(req, "body", { value: stream });
    const response = await POST(req, { params: Promise.resolve({ token }) });
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(reads).toBe(2);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("rejects an interrupted body without persisting a partial update", async () => {
    const req = request("{}");
    Object.defineProperty(req, "body", { value: new ReadableStream({
      start(controller) { controller.error(new Error("disconnected")); },
    }) });
    const response = await POST(req, { params: Promise.resolve({ token }) });
    expect(response.status).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("rejects malformed updates", async () => {
    const response = await POST(request(JSON.stringify({ update_id: -1 })), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("does not expose or accept deleted/inactive connections", async () => {
    h.connection = null;
    const response = await POST(request(JSON.stringify({ update_id: 42 })), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(404);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("returns 500 so Telegram retries if durable persistence fails", async () => {
    h.insertError = { message: "database unavailable" };
    const response = await POST(request(JSON.stringify({ update_id: 42 })), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(500);
  });
});
