import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_048_576;

function segredoValido(recebido: string | null, esperado: string | null): boolean {
  if (!recebido || !esperado) return false;
  const a = Buffer.from(recebido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function tipoDoUpdate(update: Record<string, unknown>): string {
  return ["message", "edited_message", "channel_post", "edited_channel_post"]
    .find((key) => update[key] !== undefined) ?? "other";
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;
  if (!token || token.length < 32 || token.length > 128) {
    return fail("not_found", "unknown Telegram webhook", 404, { requestId });
  }
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return fail("validation_error", "Telegram update is too large.", 413, { requestId });
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return fail("validation_error", "Telegram update is too large.", 413, { requestId });
  }

  const admin = createAdminClient();
  const { data: connection, error } = await admin
    .from("telegram_bot_connections")
    .select("id, organization_id, status, webhook_secret_encrypted")
    .eq("webhook_path_token", token)
    .maybeSingle();
  if (error)
    return fail("internal_error", "Could not resolve Telegram webhook.", 500, { requestId });
  if (!connection) return fail("not_found", "unknown Telegram webhook", 404, { requestId });
  if (connection.status !== "active") return ok({ status: "ignored", reason: "connection_inactive" }, { requestId });

  const encryptedSecret = connection.webhook_secret_encrypted;
  const expectedSecret = encryptedSecret
    ? await decryptWebhookSecret(admin, String(encryptedSecret))
    : null;
  if (!segredoValido(req.headers.get("x-telegram-bot-api-secret-token"), expectedSecret)) {
    return fail("unauthorized", "invalid Telegram webhook secret", 401, { requestId });
  }

  let update: unknown;
  try {
    update = JSON.parse(raw);
  } catch {
    return fail("validation_error", "invalid Telegram update JSON", 400, { requestId });
  }
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return fail("validation_error", "invalid Telegram update", 400, { requestId });
  }
  const record = update as Record<string, unknown>;
  const updateId = record.update_id;
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) {
    return fail("validation_error", "invalid Telegram update_id", 400, { requestId });
  }

  const { error: insertError } = await admin.from("telegram_webhook_updates").insert({
    organization_id: connection.organization_id,
    connection_id: connection.id,
    update_id: updateId,
    update_type: tipoDoUpdate(record),
    payload: record,
    status: "pending",
  });
  if (insertError?.code === "23505") {
    return ok({ status: "duplicate", update_id: updateId }, { requestId });
  }
  if (insertError) {
    return fail("internal_error", "Could not persist Telegram update.", 500, { requestId });
  }
  return ok({ status: "accepted", update_id: updateId }, { requestId });
}
