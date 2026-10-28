import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { sendTelegramText } from "@/lib/channels/telegram/bot-api";

const KEY = "escalacao-aviso-de-caso-telegram.v1";
const retry = (detail: string): HandlerResult => ({
  consumer_key: KEY,
  status: "retry",
  retry_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  detail,
});
const result = (status: HandlerResult["status"], detail: string): HandlerResult => ({
  consumer_key: KEY,
  status,
  detail,
});
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

async function opened(row: EventRow, caseId: string): Promise<HandlerResult> {
  const pool = getRequestPool(),
    admin = createAdminClient();
  const configuredResult = await pool.query<{
    group_setting_id: string;
    connection_id: string;
    group_chat_id: string;
    display_name: string;
  }>(
    "select t.id::text group_setting_id,t.connection_id::text,t.group_chat_id,c.display_name from config_aviso_de_caso a join telegram_team_group_settings t on t.organization_id=a.organization_id and t.id=a.telegram_group_setting_id join telegram_bot_connections c on c.organization_id=t.organization_id and c.id=t.connection_id where a.organization_id=$1 and a.destino_tipo='telegram' and a.ligado=true and t.case_alerts_enabled=true and t.membership_state='healthy' and t.membership_attested_at is not null and c.status='active' and c.deleted_at is null and exists(select 1 from telegram_bot_surface_capabilities x where x.organization_id=t.organization_id and x.connection_id=t.connection_id and x.surface='team_alerts' and x.capability='send_alerts')",
    [row.organization_id],
  );
  const configured = configuredResult.rows[0] ?? null;
  const current = await pool.query<{ status: string }>(
    "select status from agent_cases where organization_id=$1 and id=$2",
    [row.organization_id, caseId],
  );
  if (current.rows[0]?.status !== "awaiting_human")
    return result("skipped", "case_no_longer_awaiting_human");
  const client = await pool.connect();
  let deliveryId: string | null = null;
  let destination: typeof configured = null;
  try {
    await client.query("begin");
    // Serialize retries for a case so a changed destination cannot create a second alert.
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text,0))",
      [row.organization_id, caseId],
    );
    const prior = await client.query<{
      id: string;
      status: string;
      updated_at: string;
      group_setting_id: string;
      connection_id: string;
      group_chat_id: string;
      display_name: string;
    }>(
      "select d.id::text,d.status,d.updated_at::text,d.group_setting_id::text,d.connection_id::text,t.group_chat_id,c.display_name from telegram_case_alert_deliveries d join telegram_team_group_settings t on t.organization_id=d.organization_id and t.id=d.group_setting_id join telegram_bot_connections c on c.organization_id=d.organization_id and c.id=d.connection_id where d.organization_id=$1 and d.case_id=$2 order by d.created_at asc limit 1 for update of d",
      [row.organization_id, caseId],
    );
    const previous = prior.rows[0];
    if (previous) {
      destination = {
        group_setting_id: previous.group_setting_id,
        connection_id: previous.connection_id,
        group_chat_id: previous.group_chat_id,
        display_name: previous.display_name,
      };
      deliveryId = previous.id;
      if (previous.status === "sent" || previous.status === "cancelled") {
        await client.query("commit");
        return result("skipped", "telegram_case_alert_already_delivered");
      }
      if (
        previous.status === "sending" &&
        Date.now() - Date.parse(previous.updated_at) < 5 * 60_000
      ) {
        await client.query("commit");
        return result("skipped", "telegram_case_alert_in_progress");
      }
    } else {
      if (!configured) {
        await client.query("commit");
        return result("skipped", "telegram_case_alert_not_configured");
      }
      destination = configured;
      const inserted = await client.query<{ id: string }>(
        "insert into telegram_case_alert_deliveries(organization_id,case_id,group_setting_id,connection_id,status) values($1,$2,$3,$4,'pending') returning id::text",
        [row.organization_id, caseId, destination.group_setting_id, destination.connection_id],
      );
      deliveryId = inserted.rows[0]?.id ?? null;
    }
    if (!deliveryId || !destination) {
      await client.query("rollback");
      return retry("telegram_delivery_row_missing");
    }
    const eligibility = await client.query<{ ok: boolean }>(
      "select (t.case_alerts_enabled=true and c.status='active' and c.deleted_at is null and exists(select 1 from telegram_bot_surface_capabilities x where x.organization_id=t.organization_id and x.connection_id=t.connection_id and x.surface='team_alerts' and x.capability='send_alerts')) as ok from telegram_team_group_settings t join telegram_bot_connections c on c.organization_id=t.organization_id and c.id=t.connection_id where t.organization_id=$1 and t.id=$2 and t.membership_state='healthy' and t.membership_attested_at is not null and exists(select 1 from config_aviso_de_caso a where a.organization_id=t.organization_id and a.destino_tipo='telegram' and a.telegram_group_setting_id=t.id and a.ligado=true)",
      [row.organization_id, destination.group_setting_id],
    );
    if (!eligibility.rows[0]?.ok) {
      await client.query(
        "update telegram_case_alert_deliveries set status='cancelled',error_code='destination_unavailable',updated_at=now() where id=$1",
        [deliveryId],
      );
      await client.query("commit");
      return result("skipped", "telegram_case_alert_destination_unavailable");
    }
    const claimed = await client.query(
      "update telegram_case_alert_deliveries set status='sending',attempts=least(attempts+1,10),error_code=null,updated_at=now() where id=$1 and organization_id=$2 and status in ('pending','failed','sending') and attempts<10 returning id",
      [deliveryId, row.organization_id],
    );
    if (!claimed.rowCount) {
      await client.query("commit");
      return result("skipped", "telegram_case_alert_retry_limit");
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (!deliveryId || !destination) return retry("telegram_delivery_claim_failed");
  const adminBot = await admin
    .from("telegram_bot_connections")
    .select("token_encrypted")
    .eq("organization_id", row.organization_id)
    .eq("id", destination.connection_id)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();
  if (adminBot.error || !adminBot.data?.token_encrypted) {
    await pool.query(
      "update telegram_case_alert_deliveries set status='failed',error_code='bot_unavailable',updated_at=now() where id=$1",
      [deliveryId],
    );
    return retry("telegram_bot_unavailable");
  }
  const token = await decryptWebhookSecret(admin, String(adminBot.data.token_encrypted));
  if (!token) {
    await pool.query(
      "update telegram_case_alert_deliveries set status='failed',error_code='credential_unavailable',updated_at=now() where id=$1",
      [deliveryId],
    );
    return retry("telegram_credential_unavailable");
  }
  const callbacks = [
    {
      id: randomUUID(),
      token: randomBytes(24).toString("base64url"),
      action: "guide_reply",
      label: "Orientar resposta ao cliente",
      caseId,
    },
    {
      id: randomUUID(),
      token: randomBytes(24).toString("base64url"),
      action: "guide_question",
      label: "Orientar pergunta ao cliente",
      caseId,
    },
    {
      id: randomUUID(),
      token: randomBytes(24).toString("base64url"),
      action: "list_open",
      label: "Ver casos abertos",
      caseId: null,
    },
    {
      id: randomUUID(),
      token: randomBytes(24).toString("base64url"),
      action: "list_closed",
      label: "Ver casos fechados",
      caseId: null,
    },
  ];
  try {
    for (const c of callbacks)
      await pool.query(
        "insert into telegram_case_interactions(id,organization_id,connection_id,group_setting_id,update_id,telegram_user_id,case_id,action,status,callback_token_hash,expires_at) values($1,$2,$3,$4,null,'0',$5,$6,'received',$7,now()+interval '15 minutes')",
        [
          c.id,
          row.organization_id,
          destination.connection_id,
          destination.group_setting_id,
          c.caseId,
          c.action,
          digest(c.token),
        ],
      );
    const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
    const sent = await sendTelegramText({
      token,
      chatId: destination.group_chat_id,
      text:
        "A IA solicitou apoio da equipe em um caso humano. Caso " +
        caseId.slice(0, 8) +
        ". Abra o DeskcommCRM para ver o contexto autorizado: " +
        base +
        "/app/ai/cases?caso=" +
        encodeURIComponent(caseId),
      inlineKeyboard: [
        callbacks.slice(0, 2).map((c) => ({ text: c.label, callbackData: c.token })),
        callbacks.slice(2).map((c) => ({ text: c.label, callbackData: c.token })),
      ],
    });
    await pool.query(
      "update telegram_case_alert_deliveries set status='sent',message_id=$2,sent_at=now(),updated_at=now() where id=$1",
      [deliveryId, sent.messageId],
    );
    await pool.query(
      "update telegram_case_interactions set group_message_id=$2 where id=any($1::uuid[])",
      [callbacks.map((c) => c.id), sent.messageId],
    );
    return result("ok", "telegram_case_alert_sent");
  } catch (error) {
    await pool
      .query(
        "update telegram_case_interactions set status='expired',consumed_at=now() where id=any($1::uuid[]) and status='received'",
        [callbacks.map((c) => c.id)],
      )
      .catch(() => undefined);
    await pool
      .query(
        "update telegram_case_alert_deliveries set status='failed',error_code='telegram_send_failed',updated_at=now() where id=$1",
        [deliveryId],
      )
      .catch(() => undefined);
    return retry(error instanceof Error ? error.message : "telegram_send_failed");
  }
}
async function handle(row: EventRow): Promise<HandlerResult> {
  const id = typeof row.payload?.case_id === "string" ? row.payload.case_id : row.entity_id;
  if (!id) return result("skipped", "case_id_missing");
  if (row.event_type === "ai.case_closed") {
    await getRequestPool().query(
      "update telegram_case_alert_deliveries set status='cancelled',updated_at=now() where organization_id=$1 and case_id=$2 and status='pending'",
      [row.organization_id, id],
    );
    return result("skipped", "telegram_case_alert_closed");
  }
  try {
    return await opened(row, id);
  } catch (error) {
    return retry(error instanceof Error ? error.message : "telegram_case_alert_failed");
  }
}

export const telegramCaseAlertHandler: EventHandler = {
  key: KEY,
  naOrgParada: "pula",
  events: ["ai.case_opened", "ai.case_closed"],
  handle,
};
