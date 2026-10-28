import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_000_000;
const updateSchema = z.object({ update_id: z.number().int().nonnegative().safe() }).passthrough();

interface RouteCtx {
  params: Promise<{ token: string }>;
}

function segredoConfere(recebido: string | null, esperado: string | null): boolean {
  if (!recebido || !esperado) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Enforce the byte limit while reading, including chunked requests without Content-Length. */
async function lerCorpoLimitado(req: NextRequest): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    await req.body?.cancel();
    return null;
  }
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const admin = createAdminClient();
  const { data: connection, error: lookupError } = await admin
    .from("telegram_bot_connections")
    .select("id, organization_id, status, webhook_secret_encrypted")
    .eq("webhook_path_token", token)
    .is("deleted_at", null)
    .maybeSingle();
  if (lookupError) return fail("internal_error", "Could not resolve Telegram webhook.", 500, { requestId });
  if (!connection || connection.status !== "active") {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const encrypted = connection.webhook_secret_encrypted;
  const secret = typeof encrypted === "string" ? await decryptWebhookSecret(admin, encrypted) : null;
  if (!segredoConfere(req.headers.get("x-telegram-bot-api-secret-token"), secret)) {
    return fail("unauthorized", "invalid Telegram webhook secret", 401, { requestId });
  }

  let rawBody: string | null;
  try {
    rawBody = await lerCorpoLimitado(req);
  } catch {
    return fail("invalid_request", "invalid_body", 400, { requestId });
  }
  if (rawBody === null) {
    return fail("invalid_request", "Telegram update is too large.", 413, { requestId });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }
  const parsed = updateSchema.safeParse(payload);
  if (!parsed.success) return fail("validation_failed", "invalid Telegram update", 400, { requestId });

  const update = parsed.data;
  const updateType = [
    "message", "edited_message", "channel_post", "edited_channel_post",
    "callback_query", "chat_member", "my_chat_member",
  ].find((key) => Object.hasOwn(update, key)) ?? "unsupported";
  const { error: insertError } = await admin.from("telegram_webhook_updates").upsert({
    organization_id: connection.organization_id,
    connection_id: connection.id,
    update_id: update.update_id,
    update_type: updateType,
    payload: update,
    status: "pending",
  }, { onConflict: "connection_id,update_id", ignoreDuplicates: true });
  if (insertError) return fail("internal_error", "Could not persist Telegram update.", 500, { requestId });

  return ok({ received: true }, { requestId });
}
