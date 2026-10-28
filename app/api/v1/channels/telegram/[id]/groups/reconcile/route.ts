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
type Ctx = { params: Promise<{ id: string }> };
const schema = z
  .object({
    group_chat_id: z.string().regex(/^-?[0-9]{1,20}$/),
    confirm_observed_members_reviewed: z.literal(true),
  })
  .strict();
export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const authz = await requireRole("admin", {
    requestId,
    resource: "telegram_group_membership_attestation",
  });
  if (!authz.ok) return authz.response;
  const id = z.uuid().safeParse((await ctx.params).id),
    body = schema.safeParse(await req.json().catch(() => null));
  if (!id.success || !body.success)
    return fail("validation_error", "Invalid group attestation.", 422, { requestId });
  const client = await getRequestPool().connect();
  try {
    await client.query("begin");
    const q = await client.query<{ setting_id: string; membership_state: string }>(
      `
   select t.id::text setting_id,t.membership_state from telegram_team_group_settings t
    join telegram_bot_connections c on c.id=t.connection_id and c.organization_id=t.organization_id
   where t.organization_id=$1 and t.connection_id=$2 and t.group_chat_id=$3 and c.status='active' and c.deleted_at is null
   for update of t
  `,
      [authz.org.orgId, id.data, body.data.group_chat_id],
    );
    const g = q.rows[0];
    if (!g) {
      await client.query("rollback");
      return fail("not_found", "Telegram group not found.", 404, { requestId });
    }
    const all = await client.query<{ n: string }>(
      "select count(*)::text n from telegram_team_group_members where organization_id=$1 and group_setting_id=$2",
      [authz.org.orgId, g.setting_id],
    );
    const observedCount = Number(all.rows[0]?.n ?? 0);
    const members = await client.query<{ telegram_user_id: string }>(
      `
   select m.telegram_user_id from telegram_team_group_members m
   where m.organization_id=$1 and m.group_setting_id=$2 and
    (m.membership_status not in ('member','left') or (m.membership_status='member' and (
      m.reviewed_at is null or
      (m.approval_state in ('observer','denied') and (m.can_read_cases or m.can_use_assistant or m.can_act_on_cases or m.can_approve_members)) or
      (m.approval_state not in ('observer','denied') and (m.paired_user_id is null or not exists(
        select 1 from user_organizations u where u.organization_id=m.organization_id and u.user_id=m.paired_user_id and u.revoked_at is null and u.role in ('agent','manager','admin')
      )))
    )))
   limit 1
  `,
      [authz.org.orgId, g.setting_id],
    );
    if (observedCount === 0) {
      await client.query("rollback");
      return fail(
        "state_conflict",
        "No Telegram participants have been observed yet. The bot cannot enumerate a complete roster; wait for member events before making an explicit admin attestation.",
        409,
        { requestId },
      );
    }
    if (members.rows.length) {
      await client.query("rollback");
      return fail(
        "state_conflict",
        "Review every observed active participant. CRM operators must be paired; observers and denied participants must have no grants.",
        409,
        { requestId },
      );
    }
    const capabilities = await client.query(
      "select surface,capability from telegram_bot_surface_capabilities where organization_id=$1 and connection_id=$2 and ((surface='human_cases' and capability in ('read_cases','reply_to_cases')))",
      [authz.org.orgId, id.data],
    );
    const hasCaps =
      capabilities.rows.some(
        (r: { surface: string; capability: string }) =>
          r.surface === "human_cases" && r.capability === "read_cases",
      ) &&
      capabilities.rows.some(
        (r: { surface: string; capability: string }) =>
          r.surface === "human_cases" && r.capability === "reply_to_cases",
      );
    await client.query(
      `update telegram_team_group_settings set membership_state='healthy',membership_attested_at=now(),membership_attested_by=$3,
    assistant_disabled_reason=null,membership_checked_at=now(),updated_by=$3,updated_at=now(),
    case_actions_enabled=case when $4 then case_actions_enabled else false end
    where organization_id=$1 and id=$2`,
      [authz.org.orgId, g.setting_id, authz.user.id, hasCaps],
    );
    await client.query("commit");
    await audit({
      action: "telegram.team_group_settings_updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "telegram_bot_connection",
      resourceId: id.data,
      requestId,
      metadata: {
        group_membership_attested: true,
        group_chat_id: body.data.group_chat_id,
        observed_participant_count: observedCount,
      },
    });
    return ok(
      {
        membership_state: "healthy",
        attested_at: new Date().toISOString(),
        inventory_complete: false,
      },
      { requestId },
    );
  } catch {
    await client.query("rollback").catch(() => undefined);
    logger.error("telegram.group_reconcile_failed", { requestId });
    return fail("internal_error", "Could not attest the observed Telegram participants.", 500, {
      requestId,
    });
  } finally {
    client.release();
  }
}
