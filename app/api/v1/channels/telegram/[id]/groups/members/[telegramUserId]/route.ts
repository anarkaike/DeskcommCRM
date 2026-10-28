import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; telegramUserId: string }> };
const schema = z
  .object({
    can_use_assistant: z.boolean(),
    can_read_cases: z.boolean(),
    can_act_on_cases: z.boolean(),
    can_approve_members: z.boolean(),
  })
  .strict()
  .refine((value) => !value.can_act_on_cases || value.can_read_cases, {
    message: "Case actions require case read access.",
  })
  .refine((value) => !value.can_use_assistant || value.can_read_cases, {
    message: "The internal assistant requires case read access.",
  });

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const authz = await requireRole("admin", { requestId, resource: "telegram_group_member_grant" });
  if (!authz.ok) return authz.response;
  const params = await ctx.params;
  const connectionId = z.uuid().safeParse(params.id);
  const telegramUserId = z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .safeParse(params.telegramUserId);
  const body = schema.safeParse(await req.json().catch(() => null));
  if (!connectionId.success || !telegramUserId.success || !body.success)
    return fail("validation_error", "Invalid member grant.", 422, { requestId });

  const client = await getRequestPool().connect();
  try {
    await client.query("begin");
    const rows = await client.query<{
      setting_id: string;
      member_id: string;
      user_id: string | null;
      membership_status: string;
      connection_status: string;
      team_assistant_enabled: boolean;
      membership_state: string;
      membership_attested_at: string | null;
    }>(
      `select t.id::text setting_id,m.id::text member_id,m.paired_user_id::text user_id,m.membership_status,c.status connection_status,t.team_assistant_enabled,t.membership_state,t.membership_attested_at          from telegram_team_group_settings t          join telegram_bot_connections c on c.id=t.connection_id and c.organization_id=t.organization_id          join telegram_team_group_members m on m.group_setting_id=t.id and m.organization_id=t.organization_id         where t.organization_id=$1 and t.connection_id=$2 and m.telegram_user_id=$3 and c.deleted_at is null         for update of t,m`,
      [authz.org.orgId, connectionId.data, telegramUserId.data],
    );
    const member = rows.rows[0];
    if (!member) {
      await client.query("rollback");
      return fail("not_found", "Observed Telegram member not found.", 404, { requestId });
    }
    if (
      member.connection_status !== "active" ||
      member.membership_status !== "member" ||
      !member.user_id
    ) {
      await client.query("rollback");
      return fail(
        "state_conflict",
        "Member must be present and paired to an active CRM operator before grants can be reviewed.",
        409,
        { requestId },
      );
    }
    const crm = await client.query(
      "select 1 from user_organizations where organization_id=$1 and user_id=$2 and revoked_at is null and role in ('agent','manager','admin')",
      [authz.org.orgId, member.user_id],
    );
    if (!crm.rowCount) {
      await client.query("rollback");
      return fail("forbidden", "Paired CRM operator is no longer active.", 403, { requestId });
    }
    if (
      (body.data.can_read_cases || body.data.can_act_on_cases || body.data.can_approve_members) &&
      (member.membership_state !== "healthy" || !member.membership_attested_at)
    ) {
      await client.query("rollback");
      return fail(
        "state_conflict",
        "Reconcile the observed members before granting case or approval permissions.",
        409,
        { requestId },
      );
    }
    if (body.data.can_read_cases) {
      const caps = await client.query(
        "select capability from telegram_bot_surface_capabilities where organization_id=$1 and connection_id=$2 and surface='human_cases'",
        [authz.org.orgId, connectionId.data],
      );
      if (!caps.rows.some((r: { capability: string }) => r.capability === "read_cases")) {
        await client.query("rollback");
        return fail("forbidden", "Enable human case reading for this Telegram bot first.", 403, {
          requestId,
        });
      }
    }
    if (body.data.can_use_assistant && member.membership_state !== "healthy") {
      await client.query("rollback");
      return fail(
        "state_conflict",
        "Reconcile the observed members before granting internal assistant access.",
        409,
        { requestId },
      );
    }
    if (body.data.can_act_on_cases) {
      const caps = await client.query(
        "select capability from telegram_bot_surface_capabilities where organization_id=$1 and connection_id=$2 and surface='human_cases'",
        [authz.org.orgId, connectionId.data],
      );
      const granted = new Set(caps.rows.map((r: { capability: string }) => r.capability));
      if (!granted.has("read_cases") || !granted.has("reply_to_cases")) {
        await client.query("rollback");
        return fail(
          "forbidden",
          "Enable human case read and reply capabilities for this bot first.",
          403,
          { requestId },
        );
      }
    }
    await client.query(
      "update telegram_team_group_members set approval_state='approved',can_use_assistant=$4,can_read_cases=$5,can_act_on_cases=$6,can_approve_members=$7,reviewed_by=$8,reviewed_at=now(),updated_at=now() where organization_id=$1 and group_setting_id=$2 and id=$3",
      [
        authz.org.orgId,
        member.setting_id,
        member.member_id,
        body.data.can_use_assistant,
        body.data.can_read_cases,
        body.data.can_act_on_cases,
        body.data.can_approve_members,
        authz.user.id,
      ],
    );
    await client.query("commit");
    await audit({
      action: "telegram.team_group_settings_updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "telegram_bot_connection",
      resourceId: connectionId.data,
      requestId,
      metadata: {
        member_review: true,
        telegram_user_id: telegramUserId.data,
        can_use_assistant: body.data.can_use_assistant,
        can_read_cases: body.data.can_read_cases,
        can_act_on_cases: body.data.can_act_on_cases,
        can_approve_members: body.data.can_approve_members,
      },
    });
    return ok({ saved: true, membership_state: "requires_admin_attestation" }, { requestId });
  } catch {
    await client.query("rollback").catch(() => undefined);
    logger.error("telegram.group_member_grant_failed", { requestId });
    return fail("internal_error", "Could not update member grants.", 500, { requestId });
  } finally {
    client.release();
  }
}
