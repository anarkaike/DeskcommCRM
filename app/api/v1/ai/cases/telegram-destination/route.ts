import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
const schema = z.object({ group_setting_id: z.string().uuid().nullable() }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "telegram_case_alert_destination",
  });
  if (!authz.ok) return authz.response;
  try {
    const result = await getRequestPool().query(
      "select t.id::text group_setting_id,t.group_chat_id,g.subject,c.id::text connection_id,c.display_name bot_name,c.bot_username,t.membership_state,t.case_alerts_enabled,(t.membership_state='healthy' and t.membership_attested_at is not null) as eligible from telegram_team_group_settings t join telegram_bot_connections c on c.id=t.connection_id and c.organization_id=t.organization_id join channel_session_groups g on g.id=t.channel_session_group_id and g.organization_id=t.organization_id where t.organization_id=$1 and c.status='active' and c.deleted_at is null and t.case_alerts_enabled=true and exists(select 1 from telegram_bot_surface_capabilities x where x.organization_id=t.organization_id and x.connection_id=t.connection_id and x.surface='team_alerts' and x.capability='send_alerts') order by c.display_name,g.subject nulls last,t.group_chat_id",
      [authz.org.orgId],
    );
    const selected = await createClient();
    const { data: config, error: configError } = await selected
      .from("config_aviso_de_caso")
      .select("destino_tipo,telegram_group_setting_id")
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    if (configError) throw configError;
    return ok(
      {
        groups: result.rows,
        group_setting_id:
          config?.destino_tipo === "telegram" ? config.telegram_group_setting_id : null,
        destination_type: config?.destino_tipo ?? null,
      },
      { requestId },
    );
  } catch {
    logger.error("telegram.case_alert_destination_read_failed", { requestId });
    return fail("internal_error", "Could not load Telegram alert destinations.", 500, {
      requestId,
    });
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("admin", {
    requestId,
    resource: "telegram_case_alert_destination",
  });
  if (!authz.ok) return authz.response;
  const body = schema.safeParse(await req.json().catch(() => null));
  if (!body.success)
    return fail("validation_error", "Invalid Telegram alert destination.", 422, { requestId });
  try {
    const db = await createClient();
    const { data, error } = await db.rpc(
      "fn_definir_aviso_de_caso_telegram" as never,
      {
        p_org: authz.org.orgId,
        p_group_setting_id: body.data.group_setting_id,
      } as never,
    );
    if (error) {
      const message = error.message ?? "";
      if (message.includes("telegram_case_alert_group_ineligible")) {
        return fail("state_conflict", "This group is not eligible to receive case alerts.", 409, {
          requestId,
        });
      }
      if (message.includes("aviso_de_caso_mfa_required")) {
        return fail("mfa_required", "Confirm your identity before changing case alerts.", 403, {
          requestId,
        });
      }
      if (message.includes("aviso_de_caso_forbidden")) {
        return fail("forbidden_role", "Only an administrator can configure case alerts.", 403, {
          requestId,
        });
      }
      throw error;
    }
    await audit({
      action: "ai.case_alert_settings_changed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "config_aviso_de_caso",
      resourceId: authz.org.orgId,
      requestId,
      metadata: {
        destination_type: "telegram",
        destination_configured: Boolean(body.data.group_setting_id),
      },
    });
    return ok({ saved: true, group_setting_id: body.data.group_setting_id, data }, { requestId });
  } catch {
    logger.error("telegram.case_alert_destination_save_failed", { requestId });
    return fail("internal_error", "Could not save Telegram alert destination.", 500, { requestId });
  }
}
