import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  transfer: {} as Record<string, unknown>,
  org: {} as Record<string, unknown>,
  message: {} as Record<string, unknown>,
  consumed: { id: "transfer-row" } as Record<string, unknown> | null,
  blob: null as Blob | null,
  downloadError: null as { message: string } | null,
  downloadPath: null as string | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let updating = false;
      const chain: Record<string, (...args: unknown[]) => unknown> = {
        select: () => chain,
        update: () => { updating = true; return chain; },
        eq: () => chain,
        is: () => chain,
        gt: () => chain,
        maybeSingle: async () => {
          if (table === "mcp_artwork_transfers") return { data: updating ? deps.consumed : deps.transfer, error: null };
          if (table === "organizations") return { data: deps.org, error: null };
          if (table === "messages") return { data: deps.message, error: null };
          return { data: null, error: null };
        },
      };
      return {
        ...chain,
        storage: undefined,
      };
    },
    storage: {
      from: () => ({
        download: async (path: string) => {
          deps.downloadPath = path;
          return { data: deps.blob, error: deps.downloadError };
        },
      }),
    },
  }),
}));
vi.mock("@/lib/mcp/servidor-externo/segredo", () => ({
  abrirChaveArtworkMcpExterno: () => "test-artwork-bridge-secret-with-32-bytes",
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "./route";

const transferId = "A".repeat(43);
const organizationId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const secret = "test-artwork-bridge-secret-with-32-bytes";
const storagePath = `${organizationId}/${conversationId}/private/file.pdf`;
const fileBytes = Buffer.from("%PDF-test-private-artwork");

function signedRequest(overrides: Record<string, string> = {}) {
  const path = `/api/v1/woocommerce/artwork-transfers/${transferId}/consume`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "a".repeat(48);
  const blog = "17";
  const idempotency = "request-key-1234567890";
  const body = JSON.stringify({ contact_id: contactId });
  const canonical = [
    "POST", path, timestamp, nonce, blog, contactId, idempotency,
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-servinder-artwork-timestamp": timestamp,
      "x-servinder-artwork-nonce": nonce,
      "x-servinder-artwork-blog": blog,
      "x-servinder-artwork-contact": contactId,
      "x-servinder-artwork-idempotency": idempotency,
      "x-servinder-artwork-signature": signature,
      ...overrides,
    },
    body,
  });
}

const context = { params: Promise.resolve({ transferId }) };

beforeEach(() => {
  vi.clearAllMocks();
  deps.transfer = {
    id: "transfer-row", organization_id: organizationId, contact_id: contactId,
    conversation_id: conversationId, message_id: messageId, blog_id: 17,
    expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null,
  };
  deps.org = { mcp_externo_artwork_blog_id: 17 };
  deps.message = {
    id: messageId, organization_id: organizationId, conversation_id: conversationId,
    contact_id: contactId, direction: "inbound", media_storage_path: storagePath,
    media_mime: "application/pdf", media_size_bytes: fileBytes.length,
    metadata: { filename: "arte cliente.pdf" }, revoked_at: null,
  };
  deps.consumed = { id: "transfer-row" };
  deps.blob = new Blob([fileBytes], { type: "application/pdf" });
  deps.downloadError = null;
  deps.downloadPath = null;
});

describe("POST artwork transfer consume", () => {
  it("entrega somente o anexo inbound do contato autorizado e marca o ticket como consumido", async () => {
    const response = await POST(signedRequest(), context);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fileBytes);
    expect(response.headers.get("x-servinder-artwork-consumed")).toBe("true");
    expect(response.headers.get("x-servinder-artwork-contact")).toBe(contactId);
    expect(response.headers.get("x-servinder-artwork-filename")).toBe("arte cliente.pdf");
    expect(response.headers.get("x-servinder-artwork-sha256")).toBe(createHash("sha256").update(fileBytes).digest("hex"));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(deps.downloadPath).toBe(storagePath);
  });

  it("recusa assinatura incorreta antes de acessar Storage", async () => {
    const response = await POST(signedRequest({ "x-servinder-artwork-signature": "0".repeat(64) }), context);
    expect(response.status).toBe(401);
    expect(deps.downloadPath).toBeNull();
  });

  it("falha fechado para ticket já consumido ou contato divergente", async () => {
    deps.transfer.consumed_at = new Date().toISOString();
    const consumed = await POST(signedRequest(), context);
    expect(consumed.status).toBe(404);
    deps.transfer.consumed_at = null;
    deps.transfer.contact_id = "55555555-5555-4555-8555-555555555555";
    const crossContact = await POST(signedRequest(), context);
    expect(crossContact.status).toBe(404);
    expect(deps.downloadPath).toBeNull();
  });

  it("recusa caminhos do Storage que não pertençam à conversa", async () => {
    deps.message.media_storage_path = `${organizationId}/another-conversation/file.pdf`;
    const response = await POST(signedRequest(), context);
    expect(response.status).toBe(404);
    expect(deps.downloadPath).toBeNull();
  });
});
