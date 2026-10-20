import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { CHANNEL_CONNECTIONS, createConnectionLifecycle } from "@/lib/channels";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telegram_bot_connections" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const admin = createAdminClient();
  const { data: connection, error } = await admin.from("telegram_bot_connections")
    .select("id, status, webhook_path_token")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar a conexão Telegram.", 500, { requestId });
  if (!connection) return fail("not_found", "Essa conexão Telegram não existe nesta organização.", 404, { requestId });
  if (connection.status !== "active" || !connection.webhook_path_token) {
    return ok({
      health: "not_active",
      pending_update_count: null,
      last_error_at: null,
      webhook_matches: false,
      checked_at: new Date().toISOString(),
    }, { requestId });
  }

  const { count: appPendingCount, error: appQueueError } = await admin.from("telegram_webhook_updates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .eq("connection_id", id)
    .in("status", ["pending", "error", "processing"]);
  if (appQueueError) return fail("internal_error", "Não foi possível consultar a fila de atualizações Telegram.", 500, { requestId });

  const lifecycle = createConnectionLifecycle(CHANNEL_CONNECTIONS.get("telegram"));
  const health = await lifecycle.health({ organizationId: authz.org.orgId, connectionId: id, actorUserId: authz.user.id, request: req });
  return ok({
    health: health.healthy ? "healthy" : health.state === "disconnected" ? "not_active" : "degraded",
    pending_update_count: health.pendingCount ?? null,
    app_pending_update_count: appPendingCount ?? 0,
    last_error_at: health.lastErrorAt ?? null,
    webhook_matches: health.webhookMatches ?? false,
    checked_at: health.checkedAt,
  }, { requestId });
}
