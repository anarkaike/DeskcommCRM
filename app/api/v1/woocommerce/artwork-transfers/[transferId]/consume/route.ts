import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { abrirChaveArtworkMcpExterno } from "@/lib/mcp/servidor-externo/segredo";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_SKEW_SECONDS = 90;
const ROUTE = /^\/api\/v1\/woocommerce\/artwork-transfers\/([A-Za-z0-9_-]{40,64})\/consume$/;

interface RouteContext { params: Promise<{ transferId: string }> }

function hmacValido(secret: string, canonical: string, signature: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  // HMAC SHA-256 output is fixed-length; use timingSafeEqual on equal-size buffers.
  const actual = Buffer.from(signature, "hex");
  const digest = createHmac("sha256", secret).update(canonical).digest();
  return actual.length === digest.length && timingSafeEqual(actual, digest);
}

function attachmentName(value: unknown): string {
  const source = typeof value === "string" ? value : "arquivo-recebido";
  const name = source.split(/[\\/]/).pop()?.replace(/[\r\n";]/g, "_").trim().slice(0, 180);
  return name || "arquivo-recebido";
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const { transferId } = await context.params;
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(transferId)) return fail("not_found", "Transfer not found.", 404, { requestId });
  const path = new URL(request.url).pathname;
  if (!ROUTE.test(path)) return fail("not_found", "Transfer not found.", 404, { requestId });

  const rawBody = await request.text();
  if (rawBody.length > 2048) return fail("invalid_request", "Invalid transfer request.", 400, { requestId });
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return fail("invalid_request", "Invalid transfer request.", 400, { requestId }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { contact_id?: unknown }).contact_id !== "string") {
    return fail("invalid_request", "Invalid transfer request.", 400, { requestId });
  }

  const timestamp = request.headers.get("x-servinder-artwork-timestamp") ?? "";
  const nonce = request.headers.get("x-servinder-artwork-nonce") ?? "";
  const blogHeader = request.headers.get("x-servinder-artwork-blog") ?? "";
  const contactHeader = request.headers.get("x-servinder-artwork-contact") ?? "";
  const idempotency = request.headers.get("x-servinder-artwork-idempotency") ?? "";
  const signature = request.headers.get("x-servinder-artwork-signature") ?? "";
  const timestampNumber = Number(timestamp);
  if (!/^\d{10}$/.test(timestamp) || !Number.isSafeInteger(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > MAX_SKEW_SECONDS ||
      !/^[a-f0-9]{48}$/.test(nonce) || !/^\d{1,12}$/.test(blogHeader) || !/^[0-9a-f-]{36}$/i.test(contactHeader) || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotency)) {
    return fail("unauthorized", "Transfer authorization failed.", 401, { requestId });
  }
  if ((body as { contact_id: string }).contact_id.toLowerCase() !== contactHeader.toLowerCase()) {
    return fail("unauthorized", "Transfer authorization failed.", 401, { requestId });
  }

  const admin = createAdminClient();
  const tokenHash = createHash("sha256").update(transferId).digest("hex");
  const { data: transfer, error: transferError } = await admin.from("mcp_artwork_transfers")
    .select("id,organization_id,contact_id,conversation_id,message_id,blog_id,expires_at,consumed_at")
    .eq("token_hash", tokenHash).maybeSingle();
  if (transferError || !transfer || transfer.consumed_at || Date.parse(transfer.expires_at) <= Date.now() ||
      String(transfer.blog_id) !== blogHeader || String(transfer.contact_id).toLowerCase() !== contactHeader.toLowerCase()) {
    return fail("not_found", "Transfer not found or expired.", 404, { requestId });
  }

  const { data: org, error: orgError } = await admin.from("organizations")
    .select("mcp_externo_artwork_encrypted,mcp_externo_artwork_iv,mcp_externo_artwork_tag,mcp_externo_artwork_blog_id")
    .eq("id", transfer.organization_id).maybeSingle();
  const secret = orgError ? null : abrirChaveArtworkMcpExterno(org as never);
  if (!secret || Number((org as { mcp_externo_artwork_blog_id?: unknown } | null)?.mcp_externo_artwork_blog_id) !== Number(blogHeader)) {
    return fail("unauthorized", "Transfer authorization failed.", 401, { requestId });
  }
  const canonical = ["POST", path, timestamp, nonce, blogHeader, contactHeader.toLowerCase(), idempotency, createHash("sha256").update(rawBody).digest("hex")].join("\n");
  if (!hmacValido(secret, canonical, signature)) return fail("unauthorized", "Transfer authorization failed.", 401, { requestId });

  const { data: message, error: messageError } = await admin.from("messages")
    .select("id,organization_id,conversation_id,contact_id,direction,media_storage_path,media_mime,media_size_bytes,metadata,revoked_at")
    .eq("id", transfer.message_id).eq("organization_id", transfer.organization_id)
    .eq("conversation_id", transfer.conversation_id).eq("contact_id", transfer.contact_id)
    .eq("direction", "inbound").is("revoked_at", null).maybeSingle();
  if (messageError || !message?.media_storage_path || !isMediaPathOwnedBy(message.media_storage_path, transfer.organization_id, transfer.conversation_id)) {
    return fail("not_found", "Transfer not found or expired.", 404, { requestId });
  }
  const expectedSize = Number(message.media_size_bytes ?? 0);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_MEDIA_BYTES) return fail("payload_too_large", "Attachment is unavailable.", 410, { requestId });

  const { data: blob, error: downloadError } = await admin.storage.from("whatsapp-media").download(message.media_storage_path);
  if (downloadError || !blob || blob.size !== expectedSize || blob.size > MAX_MEDIA_BYTES) {
    return fail("not_found", "Attachment is unavailable.", 410, { requestId });
  }
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length !== expectedSize) return fail("not_found", "Attachment is unavailable.", 410, { requestId });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const now = new Date().toISOString();
  const { data: consumed, error: consumeError } = await admin.from("mcp_artwork_transfers")
    .update({ consumed_at: now }).eq("id", transfer.id).eq("organization_id", transfer.organization_id)
    .is("consumed_at", null).gt("expires_at", now).select("id").maybeSingle();
  if (consumeError || !consumed) return fail("conflict", "Transfer already consumed or expired.", 409, { requestId });

  const metadata = (message.metadata ?? {}) as Record<string, unknown>;
  const fileName = attachmentName(metadata.filename ?? metadata.file_name ?? metadata.original_filename);
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes.length),
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store, private, max-age=0",
    "X-Request-Id": requestId,
    "X-Servinder-Artwork-Consumed": "true",
    "X-Servinder-Artwork-Contact": String(transfer.contact_id),
    "X-Servinder-Artwork-Filename": fileName,
    "X-Servinder-Artwork-Size": String(bytes.length),
    "X-Servinder-Artwork-SHA256": sha256,
  });
  logger.info("woocommerce.artwork_transfer.consumed", { organization_id: transfer.organization_id, message_id: transfer.message_id, request_id: requestId });
  return new Response(bytes, { status: 200, headers });
}
