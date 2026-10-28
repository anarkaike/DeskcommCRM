import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { PoolClient } from "pg";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const uuid = z.string().uuid();
const bodySchema = z
  .object({
    group_chat_id: z.string().regex(/^-?[0-9]{1,20}$/),
    subject: z.string().max(200).nullable().optional(),
    inbox_enabled: z.boolean().optional(),
    case_alerts_enabled: z.boolean().optional(),
    case_actions_enabled: z.boolean().optional(),
    team_assistant_enabled: z.boolean().optional(),
  })
  .strict();

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telegram_team_groups" });
  if (!authz.ok) return authz.response;
  const parsed = uuid.safeParse((await ctx.params).id);
  if (!parsed.success)
    return fail("validation_error", "Invalid Telegram bot id.", 422, { requestId });
  try {
    const { rows } = await getRequestPool().query(
      `
      select g.id as channel_session_group_id, g.group_chat_id, g.subject,
             g.enabled as inbox_enabled, g.enabled_at, s.id as channel_session_id,
             coalesce(t.case_alerts_enabled,false) as case_alerts_enabled,
             exists(select 1 from public.config_aviso_de_caso a where a.organization_id=g.organization_id and a.telegram_group_setting_id=t.id and a.destino_tipo='telegram' and a.ligado=true) as selected_for_case_alerts,
             coalesce(t.case_actions_enabled,false) as case_actions_enabled,
             coalesce(t.team_assistant_enabled,false) as team_assistant_enabled,
             coalesce(t.membership_state,'unknown') as membership_state,
             t.membership_attested_at, t.assistant_disabled_reason,
             (select count(*)::int from public.telegram_team_group_members m
               where m.organization_id=g.organization_id and m.group_setting_id=t.id and m.membership_status='member') as observed_members,
             (select count(*)::int from public.telegram_team_group_members m
               where m.organization_id=g.organization_id and m.group_setting_id=t.id
                 and (m.membership_status not in ('member','left') or (m.membership_status='member' and (
                   m.reviewed_at is null or
                   (m.approval_state in ('observer','denied') and (m.can_read_cases or m.can_use_assistant or m.can_act_on_cases or m.can_approve_members)) or
                   (m.approval_state not in ('observer','denied') and (m.paired_user_id is null or not exists(
                     select 1 from public.user_organizations u
                      where u.organization_id=m.organization_id and u.user_id=m.paired_user_id
                        and u.revoked_at is null and u.role in ('agent','manager','admin')
                   )))
                 )))) as unknown_members,
             coalesce((select jsonb_agg(jsonb_build_object(
               'telegram_user_id',m.telegram_user_id,'display_name',m.display_name,'username',m.username,
               'membership_status',m.membership_status,'paired_user_id',m.paired_user_id,
               'can_use_assistant',m.can_use_assistant,'can_read_cases',m.can_read_cases,'can_act_on_cases',m.can_act_on_cases,
               'can_approve_members',m.can_approve_members,'approval_state',m.approval_state,'reviewed_at',m.reviewed_at
             ) order by m.observed_at desc) from public.telegram_team_group_members m
               where m.organization_id=g.organization_id and m.group_setting_id=t.id),'[]'::jsonb) as members
        from public.telegram_bot_connections c
        join public.channel_sessions s on s.telegram_bot_connection_id=c.id and s.organization_id=c.organization_id
        join public.channel_session_groups g on g.channel_session_id=s.id and g.organization_id=c.organization_id
        left join public.telegram_team_group_settings t
          on t.organization_id=g.organization_id and t.channel_session_group_id=g.id
       where c.organization_id=$1 and c.id=$2 and c.deleted_at is null
       order by g.subject nulls last, g.group_chat_id
    `,
      [authz.org.orgId, parsed.data],
    );
    return ok(rows, { requestId });
  } catch (error) {
    logger.error("telegram.team_groups_list_failed", {
      requestId,
      code: typeof error === "object" && error && "code" in error ? String(error.code) : "unknown",
      name: error instanceof Error ? error.name : "unknown",
    });
    return fail("internal_error", "Could not load Telegram groups.", 500, { requestId });
  }
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("admin", { requestId, resource: "telegram_team_groups" });
  if (!authz.ok) return authz.response;
  const parsedId = uuid.safeParse((await ctx.params).id);
  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedId.success || !parsedBody.success) {
    return fail("validation_error", "Invalid Telegram group settings.", 422, { requestId });
  }
  const input = parsedBody.data;
  let client: PoolClient | null = null;
  try {
    client = await getRequestPool().connect();
    await client.query("begin");
    const connection = await client.query(
      `
      select c.id, c.status, s.id as channel_session_id
        from public.telegram_bot_connections c
        join public.channel_sessions s on s.telegram_bot_connection_id=c.id and s.organization_id=c.organization_id
       where c.organization_id=$1 and c.id=$2 and c.deleted_at is null
       for update of c
    `,
      [authz.org.orgId, parsedId.data],
    );
    const row = connection.rows[0] as
      { id: string; status: string; channel_session_id: string } | undefined;
    if (!row) {
      await client.query("rollback");
      return fail("not_found", "Telegram bot not found.", 404, { requestId });
    }
    if (row.status !== "active") {
      await client.query("rollback");
      return fail("state_conflict", "Activate the Telegram bot before configuring groups.", 409, {
        requestId,
      });
    }
    const group = await client.query(
      `
      insert into public.channel_session_groups (organization_id, channel_session_id, group_chat_id, subject, enabled)
      values ($1,$2,$3,$4,coalesce($5,false))
      on conflict (organization_id, channel_session_id, group_chat_id)
      do update set subject=coalesce(excluded.subject,channel_session_groups.subject),
        enabled=case when $5::boolean is null then channel_session_groups.enabled else $5 end
      returning id
    `,
      [
        authz.org.orgId,
        row.channel_session_id,
        input.group_chat_id,
        input.subject ?? null,
        input.inbox_enabled ?? null,
      ],
    );
    const groupId = group.rows[0]?.id as string | undefined;
    if (!groupId) throw new Error("telegram_group_upsert_failed");
    const { rows: capRows } = await client.query(
      `
      select surface, capability from public.telegram_bot_surface_capabilities
       where organization_id=$1 and connection_id=$2
         and ((surface='team_alerts' and capability='send_alerts')
           or (surface='human_cases' and capability in ('read_cases','reply_to_cases'))
           or (surface='inbox' and capability in ('receive_messages','group_messages')))
    `,
      [authz.org.orgId, parsedId.data],
    );
    const caps = new Set(
      capRows.map((x: { surface: string; capability: string }) => `${x.surface}:${x.capability}`),
    );
    if (
      input.inbox_enabled === true &&
      !(caps.has("inbox:receive_messages") && caps.has("inbox:group_messages"))
    ) {
      await client.query("rollback");
      return fail("forbidden", "Enable group reception in Telegram bot settings first.", 403, {
        requestId,
      });
    }
    if (input.case_alerts_enabled === true && !caps.has("team_alerts:send_alerts")) {
      await client.query("rollback");
      return fail("forbidden", "Enable case alerts for this Telegram bot first.", 403, {
        requestId,
      });
    }
    const t = await client.query<{ id: string; membership_state: string }>(
      `
      insert into public.telegram_team_group_settings (organization_id,connection_id,channel_session_group_id,group_chat_id,updated_by)
      values ($1,$2,$3,$4,$5)
      on conflict (organization_id,connection_id,group_chat_id)
      do update set channel_session_group_id=excluded.channel_session_group_id,updated_by=excluded.updated_by,updated_at=now()
      returning id::text,membership_state,membership_attested_at,case_actions_enabled,team_assistant_enabled
    `,
      [authz.org.orgId, parsedId.data, groupId, input.group_chat_id, authz.user.id],
    );
    const team = t.rows[0] as
      | {
          id: string;
          membership_state: string;
          membership_attested_at: string | null;
          case_actions_enabled: boolean;
          team_assistant_enabled: boolean;
        }
      | undefined;
    if (!team) throw new Error("telegram_group_settings_missing");
    if (input.team_assistant_enabled === true) {
      if (team.membership_state !== "healthy" || !team.membership_attested_at) {
        await client.query("rollback");
        return fail("state_conflict", "Reconcile and attest the observed group members before enabling the internal assistant.", 409, { requestId });
      }
      if (!caps.has("human_cases:read_cases")) {
        await client.query("rollback");
        return fail("forbidden", "Enable human case reading for this Telegram bot first.", 403, { requestId });
      }
      const eligible = await client.query(
        `select 1
           from public.telegram_team_group_members m
           join public.telegram_case_operators o
             on o.organization_id=m.organization_id and o.connection_id=$1
            and o.telegram_user_id=m.telegram_user_id and o.user_id=m.paired_user_id and o.revoked_at is null
           join public.user_organizations u
             on u.organization_id=m.organization_id and u.user_id=o.user_id
            and u.revoked_at is null and u.role in ('agent','manager','admin')
          where m.organization_id=$2 and m.group_setting_id=$3 and m.membership_status='member'
            and m.reviewed_at is not null and m.can_use_assistant=true and m.can_read_cases=true
          limit 1`,
        [parsedId.data, authz.org.orgId, team.id],
      );
      if (!eligible.rowCount) {
        await client.query("rollback");
        return fail("state_conflict", "Pair and review at least one active operator with case-read and assistant grants first.", 409, { requestId });
      }
    }
    if (input.case_actions_enabled === true && team.membership_state !== "healthy") {
      await client.query("rollback");
      return fail(
        "state_conflict",
        "Reconcile and attest the observed group members before enabling case actions.",
        409,
        { requestId },
      );
    }
    if (
      input.case_actions_enabled === true &&
      !(caps.has("human_cases:read_cases") && caps.has("human_cases:reply_to_cases"))
    ) {
      await client.query("rollback");
      return fail("forbidden", "Enable human case reading and replies for this Telegram bot first.", 403, {
        requestId,
      });
    }
    await client.query(
      `
      update public.telegram_team_group_settings set
        case_alerts_enabled=coalesce($3,case_alerts_enabled),
        case_actions_enabled=coalesce($4,case_actions_enabled),
        team_assistant_enabled=coalesce($5,team_assistant_enabled),
        updated_by=$6, updated_at=now()
       where organization_id=$1 and id=$2
    `,
      [
        authz.org.orgId,
        team.id,
        input.case_alerts_enabled ?? null,
        input.case_actions_enabled ?? null,
        input.team_assistant_enabled ?? null,
        authz.user.id,
      ],
    );
    await client.query("commit");
    await audit({
      action: "telegram.team_group_settings_updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "telegram_bot_connection",
      resourceId: parsedId.data,
      requestId,
      metadata: {
        group_id: groupId,
        inbox_enabled: input.inbox_enabled ?? null,
        case_alerts_enabled: input.case_alerts_enabled ?? null,
        case_actions_enabled: input.case_actions_enabled ?? null,
        team_assistant_enabled: input.team_assistant_enabled ?? null,
      },
    });
    return ok({ saved: true, channel_session_group_id: groupId }, { requestId });
  } catch {
    if (client) await client.query("rollback").catch(() => undefined);
    logger.error("telegram.team_group_settings_save_failed", { requestId });
    return fail("internal_error", "Could not save Telegram group settings.", 500, { requestId });
  } finally {
    client?.release();
  }
}
