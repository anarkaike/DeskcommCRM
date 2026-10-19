import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";
import { getTelegramWebhookInfo } from "@/lib/channels/telegram/bot-api";

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
    .select("id, status, token_encrypted, webhook_path_token")
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

  const token = await decryptWebhookSecret(admin, String(connection.token_encrypted));
  if (!token) return fail("unprocessable_entity", "Não foi possível abrir a credencial cifrada deste bot.", 422, { requestId });
  let info;
  try {
    info = await getTelegramWebhookInfo(token);
  } catch {
    return fail("upstream_error", "Não foi possível consultar a saúde do webhook no Telegram.", 502, { requestId });
  }

  const expectedUrl = `${basePublicaDaInstalacao(req)}/api/v1/webhooks/telegram/${connection.webhook_path_token}`;
  return ok({
    health: info.url === expectedUrl && info.lastErrorDate === null ? "healthy" : "degraded",
    pending_update_count: info.pendingUpdateCount,
    last_error_at: info.lastErrorDate === null ? null : new Date(info.lastErrorDate * 1000).toISOString(),
    webhook_matches: info.url === expectedUrl,
    checked_at: new Date().toISOString(),
  }, { requestId });
}
