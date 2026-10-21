import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { PoolClient } from "pg";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const selection = z.discriminatedUnion("target", [
  z.object({ target: z.literal("all") }).strict(),
  z.object({ target: z.literal("operator"), id: z.uuid() }).strict(),
  z.object({ target: z.literal("challenge"), id: z.uuid() }).strict(),
]);

export async function GET(req: NextRequest, context: Context) {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telegram_case_operator" });
  if (!authz.ok) return authz.response;
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return fail("validation_error", "Bot inválido.", 422, { requestId });
  const rawChallenge = req.nextUrl.searchParams.get("challenge_id");
  const challenge = rawChallenge ? z.uuid().safeParse(rawChallenge) : null;
  if (challenge && !challenge.success) return fail("validation_error", "Código de vínculo inválido.", 422, { requestId });
  try {
    const pool = getRequestPool();
    const args = [authz.org.orgId, id.data];
    const connection = await pool.query("select id from telegram_bot_connections where organization_id=$1 and id=$2 and deleted_at is null", args);
    if (!connection.rowCount) return fail("not_found", "Bot não encontrado.", 404, { requestId });
    let pairingStatus: "pending" | "paired" | "expired" | "cancelled" | null = null;
    if (challenge?.success) {
      const { rows } = await pool.query(`
        select case
          when ch.consumed_at is not null and exists (
            select 1 from telegram_case_operators o
            where o.organization_id=ch.organization_id and o.connection_id=ch.connection_id
              and o.user_id=ch.user_id and o.revoked_at is null and o.paired_at>=ch.created_at
          ) then 'paired'
          when ch.consumed_at is not null then 'cancelled'
          when ch.expires_at<=now() then 'expired'
          else 'pending' end as status
        from telegram_case_pairing_challenges ch
        where ch.organization_id=$1 and ch.connection_id=$2 and ch.user_id=$3 and ch.id=$4
      `, [...args, authz.user.id, challenge.data]);
      pairingStatus = rows[0]?.status ?? "cancelled";
    }
    const { rows: operators } = await pool.query(`
      select o.id, o.user_id, o.telegram_user_id, o.paired_at,
        coalesce(nullif(u.raw_user_meta_data->>'full_name',''), nullif(u.raw_user_meta_data->>'name',''), u.email, o.user_id::text) as name,
        u.email, nullif(u.phone,'') as phone,
        exists(select 1 from user_organizations m where m.organization_id=o.organization_id and m.user_id=o.user_id and m.revoked_at is null and m.role in ('agent','manager','admin')) as authorized,
        identity.metadata->>'telegram_name' as telegram_name,
        identity.metadata->>'telegram_username' as telegram_username,
        activity.commands_30d, activity.last_used_at
      from telegram_case_operators o join auth.users u on u.id=o.user_id
      left join lateral (
        select a.metadata from api_audit_log a where a.organization_id=o.organization_id
          and a.resource_id=o.connection_id and a.actor_user_id=o.user_id
          and a.action in ('telegram.case_operator_paired','telegram.case_operator_used') and a.metadata->>'telegram_user_id'=o.telegram_user_id
          and a.created_at>=o.paired_at order by a.created_at desc limit 1
      ) identity on true
      left join lateral (
        select count(*)::int as commands_30d, max(a.created_at) as last_used_at
        from api_audit_log a where a.organization_id=o.organization_id and a.resource_id=o.connection_id
          and a.action='telegram.case_operator_used' and a.metadata->>'operator_id'=o.id::text
          and a.created_at>=greatest(o.paired_at, now()-interval '30 days')
      ) activity on true
      where o.organization_id=$1 and o.connection_id=$2 and o.revoked_at is null
      order by o.paired_at desc limit 201`, args);
    const { rows: pending } = await pool.query(`
      select ch.id,ch.user_id,ch.created_at,ch.expires_at,
        coalesce(nullif(u.raw_user_meta_data->>'full_name',''), nullif(u.raw_user_meta_data->>'name',''),u.email,ch.user_id::text) as name, u.email
      from telegram_case_pairing_challenges ch join auth.users u on u.id=ch.user_id
      where ch.organization_id=$1 and ch.connection_id=$2 and ch.consumed_at is null and ch.expires_at>now()
      order by ch.created_at desc limit 201`, args);
    return ok({ operators: operators.slice(0,200), pending: pending.slice(0,200), truncated: operators.length>200 || pending.length>200, current_user_id: authz.user.id, pairing_status: pairingStatus }, { requestId });
  } catch {
    logger.error("telegram.operators_list_failed", { requestId });
    return fail("internal_error", "Não foi possível listar os vínculos.", 500, { requestId });
  }
}

export async function DELETE(req: NextRequest, context: Context) {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telegram_case_operator" });
  if (!authz.ok) return authz.response;
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const id = z.uuid().safeParse((await context.params).id);
  const parsed = selection.safeParse(await req.json().catch(() => null));
  if (!id.success || !parsed.success) return fail("validation_error", "Selecione o vínculo a remover.", 422, { requestId });
  const target = parsed.data;
  let client: PoolClient | null = null;
  try {
    client = await getRequestPool().connect();
    await client.query("begin");
    const args = [authz.org.orgId, id.data];
    const connection = await client.query("select id from telegram_bot_connections where organization_id=$1 and id=$2 and deleted_at is null for update", args);
    if (!connection.rowCount) {
      await client.query("rollback");
      return fail("not_found", "Bot não encontrado.", 404, { requestId });
    }
    // Serialize with the pairing RPC, which locks challenges before linking.
    await client.query("select id from telegram_case_pairing_challenges where organization_id=$1 and connection_id=$2 for update", args);
    let revoked = 0;
    let cancelled = 0;
    if (target.target === "all") {
      cancelled = (await client.query("delete from telegram_case_pairing_challenges where organization_id=$1 and connection_id=$2 and consumed_at is null", args)).rowCount ?? 0;
      revoked = (await client.query("update telegram_case_operators set revoked_at=now() where organization_id=$1 and connection_id=$2 and revoked_at is null", args)).rowCount ?? 0;
    } else if (target.target === "challenge") {
      cancelled = (await client.query("delete from telegram_case_pairing_challenges where organization_id=$1 and connection_id=$2 and id=$3 and consumed_at is null", [...args,target.id])).rowCount ?? 0;
    } else {
      const result = await client.query("update telegram_case_operators set revoked_at=now() where organization_id=$1 and connection_id=$2 and id=$3 and revoked_at is null returning user_id", [...args,target.id]);
      revoked = result.rowCount ?? 0;
      if (result.rows[0]) cancelled = (await client.query("delete from telegram_case_pairing_challenges where organization_id=$1 and connection_id=$2 and user_id=$3 and consumed_at is null", [...args,result.rows[0].user_id])).rowCount ?? 0;
    }
    await client.query("commit");
    if (revoked || cancelled) await audit({ action: "telegram.case_operator_unpaired", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "telegram_bot_connection", resourceId: id.data, requestId, metadata: { target: target.target, target_id: target.target === "all" ? null : target.id, revoked, cancelled } });
    return ok({ revoked, cancelled }, { requestId });
  } catch {
    if (client) await client.query("rollback").catch(() => undefined);
    logger.error("telegram.operators_revoke_failed", { requestId });
    return fail("internal_error", "Não foi possível desvincular.", 500, { requestId });
  } finally { client?.release(); }
}
