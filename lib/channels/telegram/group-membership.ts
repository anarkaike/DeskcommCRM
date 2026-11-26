import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { sendTelegramText } from "./bot-api";

type U = {
  id?: unknown;
  is_bot?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
};
type E = {
  update_id?: unknown;
  chat?: { id?: unknown; type?: unknown; title?: unknown };
  from?: U;
  new_chat_member?: { status?: unknown; user?: U };
};
export const normalizeTelegramId = (x: unknown) =>
  typeof x === "number" && Number.isSafeInteger(x)
    ? String(x)
    : typeof x === "string" && /^-?[0-9]{1,20}$/.test(x)
      ? x
      : null;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const clean = (x: unknown, n: number) =>
  typeof x === "string"
    ? x
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, n)
    : "";
async function sendMemberReviewNotice(
  admin: SupabaseClient,
  input: { organizationId: string; connectionId: string; chatId: string },
  notice: { settingId: string; targetId: string; displayName: string; approveToken: string; denyToken: string },
) {
  const c = await admin
    .from("telegram_bot_connections")
    .select("token_encrypted")
    .eq("organization_id", input.organizationId)
    .eq("id", input.connectionId)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();
  if (c.error || !c.data?.token_encrypted) return;
  const token = await decryptWebhookSecret(admin, String(c.data.token_encrypted));
  if (!token) return;
  const sent = await sendTelegramText({
    token,
    chatId: input.chatId,
    text: "Novo participante detectado: " + notice.displayName + ". O grupo foi suspenso para revisão. Um operador autorizado pode permitir apenas acompanhamento, sem acesso a casos ou IA, ou manter o participante bloqueado. Depois, um administrador precisa revisar e reconciliar o grupo.",
    inlineKeyboard: [[
      { text: "Permitir como observador", callbackData: notice.approveToken },
      { text: "Manter bloqueado", callbackData: notice.denyToken },
    ]],
  }).catch(() => null);
  if (sent) {
    await getRequestPool().query(
      "update public.telegram_case_interactions set group_message_id=$4 where organization_id=$1 and group_setting_id=$2 and target_telegram_user_id=$3 and action in ('approve_member','deny_member') and status='received' and expires_at>now()",
      [input.organizationId, notice.settingId, notice.targetId, sent.messageId],
    );
    return;
  }
  await getRequestPool().query(
    "update public.telegram_case_interactions set status='expired',consumed_at=now() where organization_id=$1 and group_setting_id=$2 and target_telegram_user_id=$3 and action in ('approve_member','deny_member') and status='received'",
    [input.organizationId, notice.settingId, notice.targetId],
  );
}

export const normalizeTelegramMembershipStatus = (x: unknown) =>
  x === "left" || x === "kicked"
    ? "left"
    : x === "restricted"
      ? "restricted"
      : ["member", "administrator", "creator"].includes(String(x))
        ? "member"
        : "unknown";

/** Fail-closed membership observation; Telegram does not provide a complete participant roster. */
export async function handleTelegramGroupMembershipUpdate(
  admin: SupabaseClient,
  input: { organizationId: string; connectionId: string; update: Record<string, unknown> },
): Promise<boolean> {
  const botEvent = Object.hasOwn(input.update, "my_chat_member");
  const messageEvent = !botEvent && Object.hasOwn(input.update, "message");
  const message = messageEvent ? (input.update.message as E | undefined) : undefined;
  const e = (botEvent ? input.update.my_chat_member : input.update.chat_member) as E | undefined;
  const event = e ?? (message ? { chat: message.chat } : undefined);
  if (!event) return false;
  const chatId = normalizeTelegramId(event.chat?.id),
    updateId = input.update.update_id;
  const isGroupChat = ["group", "supergroup"].includes(String(event.chat?.type));
  // This observer handles only group membership state. Private messages must
  // continue through case handling and the normal Inbox ingestion pipeline.
  if (messageEvent && !isGroupChat) return false;
  if (!chatId || typeof updateId !== "number" || !Number.isSafeInteger(updateId) || !isGroupChat)
    return true;
  // Updates written by the bot must not create a human participant record.
  // They remain available to the case callback handler and the Inbox adapter.
  if (messageEvent && message?.from?.is_bot === true) return false;
  const client = await getRequestPool().connect();
  let warn = false;
  let approvalNotice: { settingId: string; targetId: string; displayName: string; approveToken: string; denyToken: string } | null = null;
  try {
    await client.query("begin");
    const s = await client.query<{ id: string }>(
      "select id::text from public.channel_sessions where organization_id=$1 and telegram_bot_connection_id=$2 limit 1",
      [input.organizationId, input.connectionId],
    );
    if (!s.rows[0]) {
      await client.query("commit");
      return true;
    }
    const g = await client.query<{ id: string }>(
      "insert into public.channel_session_groups(organization_id,channel_session_id,group_chat_id,subject,enabled) values($1,$2,$3,$4,false) on conflict(organization_id,channel_session_id,group_chat_id) do update set subject=coalesce(excluded.subject,channel_session_groups.subject) returning id::text",
      [input.organizationId, s.rows[0].id, chatId, clean(event.chat?.title, 200) || null],
    );
    if (!g.rows[0]) throw new Error("telegram_group_upsert_failed");
    const t = await client.query<{ id: string; membership_last_update_id: string | null }>(
      "insert into public.telegram_team_group_settings(organization_id,connection_id,channel_session_group_id,group_chat_id) values($1,$2,$3,$4) on conflict(organization_id,connection_id,group_chat_id) do update set updated_at=now() returning id::text,membership_last_update_id::text",
      [input.organizationId, input.connectionId, g.rows[0].id, chatId],
    );
    const setting = t.rows[0];
    if (!setting) throw new Error("telegram_group_settings_missing");
    if (
      setting.membership_last_update_id &&
      BigInt(setting.membership_last_update_id) >= BigInt(updateId)
    ) {
      await client.query(
        "update public.telegram_team_group_settings set membership_state='stale',assistant_disabled_reason='membership_update_out_of_order',case_actions_enabled=false,team_assistant_enabled=false,membership_attested_at=null,membership_attested_by=null,membership_checked_at=now() where organization_id=$1 and id=$2",
        [input.organizationId, setting.id],
      );
      await client.query("commit");
      // A group message still belongs to the Inbox pipeline (which is
      // inboxOnly for Telegram groups); membership observation must not eat it.
      return messageEvent ? false : true;
    }
    if (messageEvent && message) {
      const actor = message.from;
      const uid = normalizeTelegramId(actor?.id);
      if (uid && actor?.is_bot !== true) {
        const prior = await client.query<{
          paired_user_id: string | null;
          reviewed_at: string | null;
          membership_status: string;
          approval_state: string;
        }>(
          "select paired_user_id::text,reviewed_at::text,membership_status,approval_state from public.telegram_team_group_members where organization_id=$1 and group_setting_id=$2 and telegram_user_id=$3 for update",
          [input.organizationId, setting.id, uid],
        );
        const p = await client.query<{ user_id: string }>(
          "select o.user_id::text from public.telegram_case_operators o join public.user_organizations u on u.organization_id=o.organization_id and u.user_id=o.user_id and u.revoked_at is null and u.role in('agent','manager','admin') where o.organization_id=$1 and o.connection_id=$2 and o.telegram_user_id=$3 and o.revoked_at is null limit 1",
          [input.organizationId, input.connectionId, uid],
        );
        const name =
            [clean(actor?.first_name, 80), clean(actor?.last_name, 80)].filter(Boolean).join(" ") ||
            null,
          paired = p.rows[0]?.user_id ?? null;
        const alreadyReviewed = Boolean(
          prior.rows[0]?.reviewed_at &&
          prior.rows[0]?.membership_status === "member" &&
          ["approved", "observer", "denied"].includes(prior.rows[0]?.approval_state ?? "") &&
          prior.rows[0]?.paired_user_id === paired,
        );
        await client.query(
          `insert into public.telegram_team_group_members(organization_id,group_setting_id,telegram_user_id,paired_user_id,display_name,username,membership_status,last_update_id,observed_at) values($1,$2,$3,$4,$5,$6,'member',$7,now()) on conflict(organization_id,group_setting_id,telegram_user_id) do update set
      approval_state=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then 'pending' else telegram_team_group_members.approval_state end,
      can_read_cases=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then false else telegram_team_group_members.can_read_cases end,
      can_use_assistant=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then false else telegram_team_group_members.can_use_assistant end,
      can_act_on_cases=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then false else telegram_team_group_members.can_act_on_cases end,
      can_approve_members=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then false else telegram_team_group_members.can_approve_members end,
      reviewed_by=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then null else telegram_team_group_members.reviewed_by end,
      reviewed_at=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then null else telegram_team_group_members.reviewed_at end,
      paired_user_id=excluded.paired_user_id,display_name=coalesce(excluded.display_name,telegram_team_group_members.display_name),username=coalesce(excluded.username,telegram_team_group_members.username),membership_status='member',last_update_id=excluded.last_update_id,observed_at=now(),updated_at=now()`,
          [
            input.organizationId,
            setting.id,
            uid,
            paired,
            name,
            clean(actor?.username, 64) || null,
            updateId,
          ],
        );
        if (!alreadyReviewed) {
          await client.query(
            "update public.telegram_team_group_settings set membership_state='suspended',assistant_disabled_reason='unknown_member_observed',case_actions_enabled=false,team_assistant_enabled=false,membership_attested_at=null,membership_attested_by=null,membership_last_update_id=$3,membership_checked_at=now() where organization_id=$1 and id=$2",
            [input.organizationId, setting.id, updateId],
          );
          warn = true;
          const pending = await client.query(
            "select id from public.telegram_case_interactions where organization_id=$1 and group_setting_id=$2 and target_telegram_user_id=$3 and action in ('approve_member','deny_member') and status='received' and expires_at>now() limit 1",
            [input.organizationId, setting.id, uid],
          );
          if (!pending.rows.length) {
            const approveToken = randomBytes(24).toString("base64url");
            const denyToken = randomBytes(24).toString("base64url");
            await client.query(
              "insert into public.telegram_case_interactions(organization_id,connection_id,group_setting_id,telegram_user_id,target_telegram_user_id,action,status,callback_token_hash,expires_at) values($1,$2,$3,'0',$4,'approve_member','received',$5,now()+interval '15 minutes'),($1,$2,$3,'0',$4,'deny_member','received',$6,now()+interval '15 minutes')",
              [input.organizationId, input.connectionId, setting.id, uid, sha(approveToken), sha(denyToken)],
            );
            approvalNotice = {
              settingId: setting.id,
              targetId: uid,
              displayName: name || (actor?.username ? "@" + clean(actor.username, 64) : "Participante sem nome"),
              approveToken,
              denyToken,
            };
          }
        } else {
          await client.query(
            "update public.telegram_team_group_settings set membership_last_update_id=$3,membership_checked_at=now() where organization_id=$1 and id=$2",
            [input.organizationId, setting.id, updateId],
          );
        }
      }
      await client.query("commit");
      if (approvalNotice)
        await sendMemberReviewNotice(
          admin,
          { organizationId: input.organizationId, connectionId: input.connectionId, chatId },
          approvalNotice,
        );
      // Continue into case callbacks/commands and then the normal inbox adapter.
      // That adapter marks group traffic inboxOnly, so it can never reach customer AI.
      return false;
    }
    if (botEvent) {
      const st = normalizeTelegramMembershipStatus(event.new_chat_member?.status);
      if (st === "left" || st === "restricted") {
        await client.query(
          "update public.telegram_team_group_settings set membership_state='suspended',assistant_disabled_reason='telegram_bot_removed_or_restricted',case_actions_enabled=false,team_assistant_enabled=false,membership_attested_at=null,membership_attested_by=null,membership_last_update_id=$3,membership_checked_at=now() where organization_id=$1 and id=$2",
          [input.organizationId, setting.id, updateId],
        );
        warn = st === "left";
      } else
        await client.query(
          "update public.telegram_team_group_settings set membership_state='stale',assistant_disabled_reason='bot_membership_changed_review_required',case_actions_enabled=false,team_assistant_enabled=false,membership_attested_at=null,membership_attested_by=null,membership_last_update_id=$3,membership_checked_at=now() where organization_id=$1 and id=$2",
          [input.organizationId, setting.id, updateId],
        );
    } else {
      const actor = event.new_chat_member?.user,
        uid = normalizeTelegramId(actor?.id);
      if (!uid) {
        // A membership event without a stable actor means our observed state is
        // incomplete. Never leave the group in a state that could authorize actions.
        await client.query(
          "update public.telegram_team_group_settings set membership_state='stale',assistant_disabled_reason='membership_event_missing_actor',case_actions_enabled=false,team_assistant_enabled=false,membership_attested_at=null,membership_attested_by=null,membership_last_update_id=$3,membership_checked_at=now() where organization_id=$1 and id=$2",
          [input.organizationId, setting.id, updateId],
        );
      }
      if (uid && actor?.is_bot !== true) {
        const st = normalizeTelegramMembershipStatus(event.new_chat_member?.status);
        const prior = await client.query<{
          paired_user_id: string | null;
          reviewed_at: string | null;
          membership_status: string;
          approval_state: string;
        }>(
          "select paired_user_id::text,reviewed_at::text,membership_status,approval_state from public.telegram_team_group_members where organization_id=$1 and group_setting_id=$2 and telegram_user_id=$3 for update",
          [input.organizationId, setting.id, uid],
        );
        const p = await client.query<{ user_id: string }>(
          "select o.user_id::text from public.telegram_case_operators o join public.user_organizations u on u.organization_id=o.organization_id and u.user_id=o.user_id and u.revoked_at is null and u.role in('agent','manager','admin') where o.organization_id=$1 and o.connection_id=$2 and o.telegram_user_id=$3 and o.revoked_at is null limit 1",
          [input.organizationId, input.connectionId, uid],
        );
        const name =
            [clean(actor?.first_name, 80), clean(actor?.last_name, 80)].filter(Boolean).join(" ") ||
            null,
          paired = p.rows[0]?.user_id ?? null;
        const alreadyReviewed = Boolean(
          prior.rows[0]?.reviewed_at &&
          prior.rows[0]?.membership_status === "member" &&
          ["approved", "observer", "denied"].includes(prior.rows[0]?.approval_state ?? "") &&
          prior.rows[0]?.paired_user_id === paired,
        );
        await client.query(
          `insert into public.telegram_team_group_members(organization_id,group_setting_id,telegram_user_id,paired_user_id,display_name,username,membership_status,last_update_id,observed_at) values($1,$2,$3,$4,$5,$6,$7,$8,now()) on conflict(organization_id,group_setting_id,telegram_user_id) do update set
      approval_state=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then 'pending' else telegram_team_group_members.approval_state end,
      can_read_cases=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then false else telegram_team_group_members.can_read_cases end,
      can_use_assistant=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then false else telegram_team_group_members.can_use_assistant end,
      can_act_on_cases=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then false else telegram_team_group_members.can_act_on_cases end,
      can_approve_members=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then false else telegram_team_group_members.can_approve_members end,
      reviewed_by=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then null else telegram_team_group_members.reviewed_by end,
      reviewed_at=case when telegram_team_group_members.paired_user_id is distinct from excluded.paired_user_id or telegram_team_group_members.membership_status is distinct from excluded.membership_status then null else telegram_team_group_members.reviewed_at end,
      paired_user_id=excluded.paired_user_id,display_name=coalesce(excluded.display_name,telegram_team_group_members.display_name),username=coalesce(excluded.username,telegram_team_group_members.username),membership_status=excluded.membership_status,last_update_id=excluded.last_update_id,observed_at=now(),updated_at=now()`,
          [
            input.organizationId,
            setting.id,
            uid,
            paired,
            name,
            clean(actor?.username, 64) || null,
            st,
            updateId,
          ],
        );
        if (st === "member" && !alreadyReviewed) {
          await client.query(
            "update public.telegram_team_group_settings set membership_state='suspended',assistant_disabled_reason='unknown_member_observed',case_actions_enabled=false,team_assistant_enabled=false,membership_attested_at=null,membership_attested_by=null,membership_last_update_id=$3,membership_checked_at=now() where organization_id=$1 and id=$2",
            [input.organizationId, setting.id, updateId],
          );
          warn = true;
        } else
          await client.query(
            "update public.telegram_team_group_settings set membership_state=case when $3='left' then 'stale' else membership_state end,membership_last_update_id=$4,membership_checked_at=now() where organization_id=$1 and id=$2",
            [input.organizationId, setting.id, st, updateId],
          );
      }
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  if (warn) {
    const c = await admin
      .from("telegram_bot_connections")
      .select("token_encrypted")
      .eq("organization_id", input.organizationId)
      .eq("id", input.connectionId)
      .eq("status", "active")
      .is("deleted_at", null)
      .maybeSingle();
    if (!c.error && c.data?.token_encrypted) {
      const token = await decryptWebhookSecret(admin, String(c.data.token_encrypted));
      if (token)
        await sendTelegramText({
          token,
          chatId,
          text: "Security: a participant or bot access change was detected. Case actions and internal assistance are paused until an administrator reviews the group in the CRM.",
        }).catch(() => undefined);
    }
  }
  return true;
}
