import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { getInboundDriver } from "@/lib/channels/inbound/registry";
import { logger } from "@/lib/logger";
import { STATUS_OPERANTE, ehOperante, statusDaOrgEmbutida } from "@/lib/organizacao/operante";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  const admin = createAdminClient();
  const { error: recoveryError } = await admin.from("telegram_webhook_updates")
    .update({ status: "error", processing_at: null, last_error: "worker_interrupted_retrying" })
    .eq("status", "processing")
    .lt("processing_at", new Date(Date.now() - 5 * 60_000).toISOString());
  if (recoveryError) return fail("internal_error", "Could not recover interrupted Telegram updates.", 500, { requestId });
  const { error: expiredError } = await admin.from("telegram_webhook_updates")
    .delete()
    .in("status", ["processed", "ignored"])
    .lt("received_at", new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString());
  if (expiredError) return fail("internal_error", "Could not expire old Telegram update receipts.", 500, { requestId });
  const { error: deadLetterError } = await admin.from("telegram_webhook_updates")
    .update({ status: "ignored", payload: {}, last_error: "retry_limit_exceeded" })
    .eq("status", "error")
    .gte("attempts", 8)
    .lt("received_at", new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString());
  if (deadLetterError) return fail("internal_error", "Could not expire failed Telegram payloads.", 500, { requestId });
  const { data: updates, error } = await admin.from("telegram_webhook_updates")
    .select("id, organization_id, connection_id, payload, attempts, organizations:organization_id!inner(status)")
    .eq("organizations.status", STATUS_OPERANTE)
    .in("status", ["pending", "error"])
    .lt("attempts", 8)
    .order("received_at", { ascending: true })
    .limit(25);
  if (error) return fail("internal_error", "Could not load Telegram updates.", 500, { requestId });

  type UpdateRow = {
    id: string;
    organization_id: string;
    connection_id: string;
    payload: unknown;
    attempts: number;
    organizations: { status?: string | null } | Array<{ status?: string | null }> | null;
  };
  const rows = (updates ?? []) as unknown as UpdateRow[];

  let processed = 0;
  let ignored = 0;
  let failed = 0;
  for (const row of rows) {
    // Query filter applies before the batch limit; this per-row assertion is a
    // second fail-closed check if relationship data or status semantics change.
    if (!ehOperante(statusDaOrgEmbutida(row.organizations))) continue;
    const { data: claim, error: claimError } = await admin.from("telegram_webhook_updates")
      .update({ status: "processing", attempts: row.attempts + 1, processing_at: new Date().toISOString() })
      .eq("id", row.id)
      .in("status", ["pending", "error"])
      .select("id")
      .maybeSingle();
    if (claimError) { failed++; continue; }
    if (!claim) continue;

    try {
      const { data: connection, error: connectionError } = await admin.from("telegram_bot_connections")
        .select("status")
        .eq("organization_id", row.organization_id)
        .eq("id", row.connection_id)
        .maybeSingle();
      if (connectionError) throw new Error("telegram_connection_lookup_failed");
      if (connection?.status === "paused") {
        await admin.from("telegram_webhook_updates").update({ status: "deferred", attempts: row.attempts, processing_at: null })
          .eq("id", row.id).eq("status", "processing");
        continue;
      }
      const result = !connection || connection.status !== "active"
        ? "ignored"
        : await getInboundDriver("telegram").ingest(admin, {
            organizationId: row.organization_id,
            connectionId: row.connection_id,
            update: row.payload as Record<string, unknown>,
          });
      const status = result === "ignored" ? "ignored" : "processed";
      const { error: finishError } = await admin.from("telegram_webhook_updates").update({
        status, processed_at: new Date().toISOString(), last_error: null, processing_at: null, payload: {},
      }).eq("id", row.id).eq("status", "processing");
      if (finishError) throw new Error("telegram_update_ack_failed");
      if (status === "ignored") ignored++; else processed++;
    } catch (cause) {
      failed++;
      const code = cause instanceof Error ? cause.message : "telegram_update_failed";
      await admin.from("telegram_webhook_updates").update({ status: "error", last_error: code, processing_at: null })
        .eq("id", row.id).eq("status", "processing");
      logger.warn("[telegram-updates] atualização falhou", { request_id: requestId, update_id: row.id, code });
    }
  }
  return ok({ selected: updates?.length ?? 0, processed, ignored, failed }, { requestId });
}
