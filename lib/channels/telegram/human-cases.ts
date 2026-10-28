import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { resolveCaseFromHuman, markAwaitingLead } from "@/lib/agent-engine/agent/human-cases";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { sendTelegramText } from "./bot-api";

type TelegramMessage = { text?: unknown; chat?: { id?: unknown; type?: unknown }; from?: { id?: unknown; is_bot?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown } };
const OPEN_CASE_STATES = ["awaiting_human", "awaiting_lead"] as const;

function clean(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export async function handleTelegramHumanCaseUpdate(
  admin: SupabaseClient,
  input: { organizationId: string; connectionId: string; update: Record<string, unknown> },
): Promise<boolean> {
  const message = input.update.message as TelegramMessage | undefined;
  const chat = message?.chat;
  const from = message?.from;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!text.startsWith("/") || chat?.type !== "private"
      || (typeof chat.id !== "number" && typeof chat.id !== "string")
      || (typeof from?.id !== "number" && typeof from?.id !== "string") || from.is_bot === true) return false;

  const command = ((text.split(/\s+/, 1)[0] ?? "").split("@", 1)[0] ?? "").toLowerCase();
  if (!["/parear", "/casos", "/caso", "/responder"].includes(command)) return false;

  // Slash commands owned by this surface must never fall through to Inbox/AI,
  // even if an admin has since revoked the capabilities or a lookup failed.
  const { data: grants, error: grantsError } = await admin.from("telegram_bot_surface_capabilities")
    .select("capability").eq("organization_id", input.organizationId)
    .eq("connection_id", input.connectionId).eq("surface", "human_cases");
  if (grantsError) throw new Error("telegram_case_capability_lookup_failed");
  const capabilities = new Set((grants ?? []).map((row: { capability: string }) => row.capability));

  const { data: connection, error: connectionError } = await admin.from("telegram_bot_connections")
    .select("token_encrypted").eq("organization_id", input.organizationId)
    .eq("id", input.connectionId).eq("status", "active").is("deleted_at", null).maybeSingle();
  if (connectionError || !connection?.token_encrypted) throw new Error("telegram_case_connection_unavailable");
  const token = await decryptWebhookSecret(admin, String(connection.token_encrypted));
  if (!token) throw new Error("telegram_case_token_unavailable");
  const chatId = String(chat.id), telegramUserId = String(from.id);
  const reply = async (value: string) => sendTelegramText({ token, chatId, text: value });
  if (!capabilities.has("read_cases")) {
    await reply("Os comandos de casos estão desativados para este bot.");
    return true;
  }

  if (command === "/parear") {
    const code = text.split(/\s+/)[1] ?? "";
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(code)) {
      await reply("Código inválido. Gere um novo código em Conexões → Telegram → Parear operador.");
      return true;
    }
    const hash = createHash("sha256").update(code).digest("hex");
    const { data: userId, error } = await admin.rpc("fn_telegram_case_operator_pair" as never, {
      p_organization_id: input.organizationId, p_connection_id: input.connectionId,
      p_code_hash: hash, p_telegram_user_id: telegramUserId,
    } as never);
    if (error || !userId) {
      await reply("Não foi possível parear. O código pode ter expirado ou a configuração pode ter sido desativada.");
      return true;
    }
    await audit({
      action: "telegram.case_operator_paired", actorUserId: String(userId),
      organizationId: input.organizationId, resourceType: "telegram_bot_connection",
      resourceId: input.connectionId, metadata: { telegram_user_id: telegramUserId, telegram_name: [clean(from.first_name, 80), clean(from.last_name, 80)].filter(Boolean).join(" "), telegram_username: clean(from.username, 64) },
    });
    await reply("Conta pareada. Use /casos para listar os casos humanos abertos.");
    return true;
  }

  const { data: operator, error: operatorError } = await admin.from("telegram_case_operators")
    .select("id, user_id").eq("organization_id", input.organizationId).eq("connection_id", input.connectionId)
    .eq("telegram_user_id", telegramUserId).is("revoked_at", null).maybeSingle();
  const membership = operator ? await admin.from("user_organizations").select("role")
    .eq("organization_id", input.organizationId).eq("user_id", operator.user_id).is("revoked_at", null)
    .in("role", ["agent", "manager", "admin"]).maybeSingle() : { data: null, error: null };
  if (membership.error) throw new Error("telegram_case_membership_lookup_failed");
  if (operatorError || !operator || !membership.data) {
    await reply("Este Telegram não está pareado a um atendente autorizado. Gere um código no CRM e use /parear.");
    return true;
  }

  await audit({
    action: "telegram.case_operator_used", actorUserId: String(operator.user_id),
    organizationId: input.organizationId, resourceType: "telegram_bot_connection",
    resourceId: input.connectionId, metadata: { operator_id: operator.id, command, telegram_user_id: telegramUserId, telegram_name: [clean(from.first_name, 80), clean(from.last_name, 80)].filter(Boolean).join(" "), telegram_username: clean(from.username, 64) },
  });

  if (command === "/casos") {
    const { rows } = await getRequestPool().query<{ id: string; title: string; status: string }>(
      `select id::text, title, status from agent_cases
        where organization_id=$1 and status=any($2::text[]) order by opened_at asc limit 12`,
      [input.organizationId, OPEN_CASE_STATES],
    );
    await reply(rows.length
      ? ["Casos abertos:", ...rows.map((row) => `• ${row.id.slice(0, 8)} · ${clean(row.title, 180)} · ${row.status}`),
          "Use /caso ID para detalhes. Responda com /responder ID resolvido TEXTO ou /responder ID perguntar TEXTO."].join("\n")
      : "Não há casos humanos abertos nesta organização.");
    return true;
  }

  if (command === "/caso") {
    const prefix = text.split(/\s+/)[1] ?? "";
    if (!/^[0-9a-f-]{8,36}$/i.test(prefix)) { await reply("Uso: /caso ID"); return true; }
    const { rows } = await getRequestPool().query<{ id: string; status: string; title: string; summary: string; blocker: string }>(
      `select id::text, status, title, summary, blocker from agent_cases
        where organization_id=$1 and id::text like $2 and status=any($3::text[]) limit 2`,
      [input.organizationId, `${prefix}%`, OPEN_CASE_STATES],
    );
    if (rows.length !== 1) {
      await reply(rows.length ? "ID ambíguo; use mais caracteres." : "Caso aberto não encontrado nesta organização.");
      return true;
    }
    const item = rows[0];
    if (!item) { await reply("Caso aberto não encontrado nesta organização."); return true; }
    await reply(`Caso ${item.id.slice(0, 8)} · ${item.status}\n${clean(item.title)}\n\n${clean(item.summary)}\n\nBloqueio: ${clean(item.blocker)}\n\nPara responder: /responder ${item.id.slice(0, 8)} resolvido TEXTO ou /responder ${item.id.slice(0, 8)} perguntar TEXTO`);
    return true;
  }

  if (!capabilities.has("reply_to_cases")) {
    await reply("Respostas de casos estão desativadas para este bot.");
    return true;
  }
  const match = text.match(/^\/responder(?:@\w+)?\s+([0-9a-f-]{8,36})\s+(resolvido|perguntar)\s+([\s\S]+)$/i);
  if (!match) { await reply("Uso: /responder ID resolvido TEXTO ou /responder ID perguntar TEXTO"); return true; }
  const prefix = match[1] ?? "";
  const actionName = match[2] ?? "";
  const body = clean(match[3], 4000);
  if (!prefix || !actionName || !body) { await reply("Escreva uma resposta após a ação."); return true; }

  const pool = getRequestPool();
  const { rows } = await pool.query<{ id: string; status: string; contact_id: string | null }>(
    `select c.id::text, c.status, conv.contact_id from agent_cases c
       join conversations conv on conv.id=c.conversation_id and conv.organization_id=c.organization_id
      where c.organization_id=$1 and c.id::text like $2 limit 2`,
    [input.organizationId, `${prefix}%`],
  );
  const item = rows[0];
  if (rows.length !== 1 || !item || item.status !== "awaiting_human" || !item.contact_id) {
    await reply(rows.length > 1 ? "ID ambíguo; use mais caracteres." : "Caso não está aguardando resposta humana.");
    return true;
  }
  const action = actionName.toLowerCase() === "resolvido" ? "resolved" : "need_lead_info";
  const client = await pool.connect();
  let transitioned = false;
  try {
    await client.query("begin");
    transitioned = action === "resolved"
      ? await resolveCaseFromHuman(client, input.organizationId, item.id, String(operator.user_id), body)
      : await markAwaitingLead(client, input.organizationId, item.id, String(operator.user_id), body);
    if (transitioned) {
      await enqueueJob(client, input.organizationId, { kind: "case_reply_turn", leadId: item.contact_id, payload: { case_id: item.id, action, body } });
      await client.query("commit");
    } else await client.query("rollback");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
  if (!transitioned) { await reply("Outra pessoa já respondeu a esse caso. Atualize com /casos."); return true; }
  await audit({
    action: "telegram.case_replied", actorUserId: String(operator.user_id),
    organizationId: input.organizationId, resourceType: "agent_case", resourceId: item.id,
    metadata: { case_action: action },
  });
  await reply(action === "resolved" ? "Resposta registrada. O agente continuará o atendimento ao cliente." : "Pedido de informação registrado; o agente retomará quando o cliente responder.");
  return true;
}
