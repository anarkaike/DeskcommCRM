import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import {
  deleteTelegramWebhook,
  setTelegramWebhook,
  validateTelegramBotToken,
} from "@/lib/channels/telegram/bot-api";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";
import { atualizarEstadoDaSessaoTelegram, prepararSessaoTelegram } from "@/lib/channels/telegram/session";
import { CHANNEL_CONNECTIONS, createConnectionLifecycle } from "@/lib/channels";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const surfaceNames = ["inbox"] as const;
const capabilitiesBySurface = {
  inbox: ["receive_messages", "human_replies", "ai_replies"],
} as const;
type Surface = keyof typeof capabilitiesBySurface;

const connectSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
  token: z
    .string()
    .trim()
    .regex(/^\d{5,15}:[A-Za-z0-9_-]{20,}$/),
});

const settingsSchema = z
  .object({
    connection_id: z.string().uuid(),
    bindings: z
      .array(
        z.object({
          surface: z.enum(surfaceNames),
          capabilities: z.array(z.string().min(1).max(40)).max(10),
        }),
      )
      .max(5),
  })
  .superRefine((input, context) => {
    const surfaces = new Set<string>();
    for (const binding of input.bindings) {
      if (surfaces.has(binding.surface)) {
        context.addIssue({ code: "custom", message: "surface_duplicated" });
      }
      surfaces.add(binding.surface);
      const allowed: readonly string[] = capabilitiesBySurface[binding.surface as Surface];
      for (const capability of binding.capabilities) {
        if (!allowed.includes(capability)) {
          context.addIssue({ code: "custom", message: "capability_not_allowed_for_surface" });
        }
      }
    }
  });

const lifecycleSchema = z.object({
  action: z.enum(["activate", "pause", "reactivate", "disconnect", "delete"]),
  connection_id: z.string().uuid(),
});

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telegram_bot_connections" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("telegram_bot_connections")
    .select(
      "id, telegram_bot_id, bot_username, display_name, token_last4, status, created_at, updated_at",
    )
    .eq("organization_id", authz.org.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error)
    return fail("internal_error", "Não foi possível carregar os bots Telegram.", 500, {
      requestId,
    });

  const ids = (rows ?? []).map((row) => row.id);
  const { data: bindings, error: bindingsError } = ids.length
    ? await admin
        .from("telegram_bot_bindings")
        .select("connection_id, surface")
        .eq("organization_id", authz.org.orgId)
        .in("connection_id", ids)
    : { data: [], error: null };
  if (bindingsError)
    return fail("internal_error", "Não foi possível carregar os usos dos bots.", 500, {
      requestId,
    });

  const { data: capabilities, error: capabilitiesError } = ids.length
    ? await admin
        .from("telegram_bot_surface_capabilities")
        .select("connection_id, surface, capability")
        .eq("organization_id", authz.org.orgId)
        .in("connection_id", ids)
    : { data: [], error: null };
  if (capabilitiesError)
    return fail("internal_error", "Não foi possível carregar as permissões dos bots.", 500, {
      requestId,
    });

  const result = (rows ?? []).map((row) => ({
    id: row.id,
    telegram_bot_id: row.telegram_bot_id,
    bot_username: row.bot_username,
    display_name: row.display_name,
    token_last4: row.token_last4,
    status: row.status,
    created_at: row.created_at,
    bindings: (bindings ?? [])
      .filter((binding) => binding.connection_id === row.id)
      .map((binding) => ({
        surface: binding.surface,
        capabilities: (capabilities ?? [])
          .filter(
            (capability) =>
              capability.connection_id === row.id && capability.surface === binding.surface,
          )
          .map((capability) => capability.capability),
      })),
  }));
  return ok({ bots: result }, { requestId });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telegram_bot_connections" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const parsed = connectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_error", "Informe um nome e um token de bot Telegram válido.", 422, {
      requestId,
    });

  const identity = await validateTelegramBotToken(parsed.data.token);
  if (!identity)
    return fail(
      "invalid_credentials",
      "O Telegram não validou esse token. Confira o token no BotFather e tente novamente.",
      422,
      { requestId },
    );

  const admin = createAdminClient();
  const encrypted = await encryptWebhookSecret(admin, parsed.data.token);
  if (!encrypted)
    return fail(
      "unprocessable_entity",
      "A instalação não está pronta para armazenar credenciais com segurança. Avise o administrador.",
      422,
      { requestId },
    );

  const { data: bot, error } = await admin
    .from("telegram_bot_connections")
    .insert({
      organization_id: authz.org.orgId,
      telegram_bot_id: identity.id,
      bot_username: identity.username,
      display_name: parsed.data.display_name,
      token_encrypted: encrypted,
      token_last4: parsed.data.token.slice(-4),
      status: "draft",
      created_by: authz.user.id,
      updated_by: authz.user.id,
    })
    .select("id, telegram_bot_id, bot_username, display_name, token_last4, status, created_at")
    .maybeSingle();

  if (error?.code === "23505")
    return fail("state_conflict", "Este bot já está conectado em uma organização desta instalação.", 409, {
      requestId,
    });
  if (error || !bot)
    return fail("internal_error", "Não foi possível salvar o bot validado.", 500, { requestId });

  await audit({
    action: "telegram.bot_connected",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "telegram_bot_connection",
    resourceId: bot.id,
    requestId,
    metadata: { telegram_bot_id: identity.id, bot_username: identity.username },
  });
  return ok({ bot }, { status: 201, requestId });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telegram_bot_connections" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const body = await req.json().catch(() => null);
  const lifecycle = lifecycleSchema.safeParse(body);
  if (lifecycle.success) {
    return manageLifecycle({
      requestId,
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      req,
      ...lifecycle.data,
    });
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success)
    return fail("validation_error", "As opções de uso do bot são inválidas.", 422, { requestId });

  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin
    .from("telegram_bot_connections")
    .select("status")
    .eq("organization_id", authz.org.orgId)
    .eq("id", parsed.data.connection_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (connectionError)
    return fail("internal_error", "Não foi possível verificar o estado do bot.", 500, { requestId });
  if (!connection)
    return fail("not_found", "Esse bot não foi encontrado nesta organização.", 404, { requestId });
  if (connection.status === "active")
    return fail("state_conflict", "Pause o bot antes de alterar as configurações.", 409, { requestId });

  const payload = parsed.data.bindings.map((binding) => ({
    surface: binding.surface,
    capabilities: binding.capabilities,
  }));
  const { data, error } = await admin.rpc("fn_telegram_bot_save_bindings", {
    p_organization_id: authz.org.orgId,
    p_connection_id: parsed.data.connection_id,
    p_bindings: payload,
    p_actor_user_id: authz.user.id,
  });
  if (error?.code === "P0002")
    return fail("not_found", "Esse bot não foi encontrado nesta organização.", 404, { requestId });
  if (error)
    return fail("internal_error", "Não foi possível salvar a configuração do bot.", 500, {
      requestId,
    });
  if (!data)
    return fail("internal_error", "A configuração do bot não foi confirmada.", 500, { requestId });

  await audit({
    action: "telegram.bot_settings_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "telegram_bot_connection",
    resourceId: parsed.data.connection_id,
    requestId,
    metadata: { surfaces: payload.map((binding) => binding.surface) },
  });
  return ok({ saved: true }, { requestId });
}

async function manageLifecycle(input: {
  requestId: string;
  organizationId: string;
  actorUserId: string;
  req: NextRequest;
  action: z.infer<typeof lifecycleSchema>["action"];
  connection_id: string;
}): Promise<NextResponse> {
  const admin = createAdminClient();
  const { data: connection, error } = await admin
    .from("telegram_bot_connections")
    .select("id, telegram_bot_id, display_name, token_encrypted, status, webhook_path_token")
    .eq("organization_id", input.organizationId)
    .eq("id", input.connection_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível carregar o bot Telegram.", 500, { requestId: input.requestId });
  if (!connection)
    return fail("not_found", "Esse bot não foi encontrado nesta organização.", 404, { requestId: input.requestId });

  if (input.action === "activate" || input.action === "reactivate") {
    const token = await decryptWebhookSecret(admin, String(connection.token_encrypted));
    if (!token)
      return fail("unprocessable_entity", "Não foi possível abrir a credencial cifrada deste bot.", 422, { requestId: input.requestId });
    const { data: receiveBinding, error: bindingError } = await admin
      .from("telegram_bot_surface_capabilities")
      .select("capability")
      .eq("organization_id", input.organizationId)
      .eq("connection_id", input.connection_id)
      .eq("surface", "inbox")
      .in("capability", ["receive_messages", "human_replies", "ai_replies"]);
    if (bindingError)
      return fail("internal_error", "Não foi possível validar o uso de Inbox deste bot.", 500, { requestId: input.requestId });
    const capabilities = new Set((receiveBinding ?? []).map((row) => row.capability));
    if (!capabilities.has("receive_messages") || (!capabilities.has("human_replies") && !capabilities.has("ai_replies")))
      return fail("state_conflict", "Configure o recebimento e ao menos um tipo de resposta na Inbox antes de ativar o bot.", 409, { requestId: input.requestId });

    const driver = CHANNEL_CONNECTIONS.get("telegram");
    const lifecycle = createConnectionLifecycle(driver);
    const identity = await lifecycle.validate(token);
    if (!identity || identity.providerAccountId !== connection.telegram_bot_id)
      return fail("invalid_credentials", "O token não é mais válido para este bot.", 422, { requestId: input.requestId });
    const { data: allCapabilities, error: allCapabilitiesError } = await admin
      .from("telegram_bot_surface_capabilities")
      .select("surface, capability")
      .eq("organization_id", input.organizationId)
      .eq("connection_id", input.connection_id);
    if (allCapabilitiesError)
      return fail("internal_error", "Não foi possível validar as permissões deste bot.", 500, { requestId: input.requestId });
    const record = {
      provider: "telegram" as const,
      status: connection.status as "draft" | "configured" | "active" | "paused" | "disconnected" | "error" | "deleted",
      grants: Object.values((allCapabilities ?? []).reduce<Record<string, { surface: string; capabilities: string[] }>>((map, row) => {
        const binding = map[row.surface] ?? { surface: row.surface, capabilities: [] as string[] };
        (binding.capabilities as string[]).push(row.capability);
        map[row.surface] = binding;
        return map;
      }, {})),
    };
    const context = {
      organizationId: input.organizationId,
      connectionId: input.connection_id,
      actorUserId: input.actorUserId,
      expectedAccountId: connection.telegram_bot_id,
    };
    const lifecycleDecision = await lifecycle.activate(context, record, [
      { surface: "inbox", capability: "receive_messages" },
    ]);
    if (!lifecycleDecision.allowed) {
      const message = lifecycleDecision.reason === "already_active"
        ? "Esse bot já está ativo no Telegram."
        : lifecycleDecision.reason === "missing_required_grant"
          ? "Configure o recebimento e ao menos um tipo de resposta na Inbox antes de ativar o bot."
          : "Este bot não pode ser ativado no estado atual.";
      return fail("state_conflict", message, 409, { requestId: input.requestId });
    }
    const pathToken = randomBytes(32).toString("base64url");
    const webhookSecret = randomBytes(32).toString("base64url");
    const encryptedSecret = await encryptWebhookSecret(admin, webhookSecret);
    if (!encryptedSecret)
      return fail("unprocessable_entity", "A instalação não conseguiu cifrar o segredo do webhook.", 422, { requestId: input.requestId });

    if (!await prepararSessaoTelegram(admin, {
      organizationId: input.organizationId,
      connectionId: input.connection_id,
      displayName: connection.display_name,
      actorUserId: input.actorUserId,
      encryptedSecret,
    }))
      return fail("internal_error", "Não foi possível preparar a sessão da Inbox Telegram.", 500, { requestId: input.requestId });

    const base = basePublicaDaInstalacao(input.req);
    const { error: updateError } = await admin
      .from("telegram_bot_connections")
      .update({
        status: "active",
        webhook_path_token: pathToken,
        webhook_secret_encrypted: encryptedSecret,
        webhook_last_error: null,
        webhook_last_error_at: null,
        webhook_connected_at: new Date().toISOString(),
        updated_by: input.actorUserId,
      })
      .eq("organization_id", input.organizationId)
      .eq("id", input.connection_id);
    if (updateError) {
      await deleteTelegramWebhook(token).catch(() => undefined);
      return fail("internal_error", "O webhook foi aceito, mas não foi possível registrar o estado. Tente ativar novamente.", 500, { requestId: input.requestId });
    }
    if (!await atualizarEstadoDaSessaoTelegram(admin, {
      organizationId: input.organizationId,
      connectionId: input.connection_id,
      status: "WORKING",
      reason: null,
      encryptedSecret,
    })) {
      await admin.from("telegram_bot_connections").update({
        status: connection.status,
        webhook_path_token: null,
        webhook_secret_encrypted: null,
        updated_by: input.actorUserId,
      }).eq("organization_id", input.organizationId).eq("id", input.connection_id);
      return fail("internal_error", "Não foi possível preparar a sessão do Inbox; o webhook não foi registrado.", 500, { requestId: input.requestId });
    }
    try {
      await setTelegramWebhook({
        token,
        url: `${base}/api/v1/webhooks/telegram/${pathToken}`,
        secretToken: webhookSecret,
      });
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "telegram_webhook_setup_failed";
      await admin.from("telegram_bot_connections").update({
        status: connection.status,
        webhook_path_token: null,
        webhook_secret_encrypted: null,
        updated_by: input.actorUserId,
      }).eq("organization_id", input.organizationId).eq("id", input.connection_id);
      await atualizarEstadoDaSessaoTelegram(admin, {
        organizationId: input.organizationId,
        connectionId: input.connection_id,
        status: "STOPPED",
        reason: "telegram_webhook_setup_failed",
      });
      return fail("upstream_error", "O Telegram recusou a ativação do webhook.", 502, {
        requestId: input.requestId,
        details: { code },
      });
    }
    await admin.from("telegram_webhook_updates")
      .update({ status: "pending", attempts: 0, processing_at: null })
      .eq("organization_id", input.organizationId)
      .eq("connection_id", input.connection_id)
      .eq("status", "deferred");
    await audit({
      action: "telegram.bot_activated",
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      resourceType: "telegram_bot_connection",
      resourceId: input.connection_id,
      requestId: input.requestId,
      metadata: { telegram_bot_id: connection.telegram_bot_id },
    });
    return ok({ status: "active" }, { requestId: input.requestId });
  }

  const token = connection.status === "active" || connection.webhook_path_token
    ? await decryptWebhookSecret(admin, String(connection.token_encrypted))
    : null;
  if ((connection.status === "active" || connection.webhook_path_token) && !token)
    return fail("unprocessable_entity", "Não foi possível abrir a credencial cifrada deste bot para remover o webhook.", 422, { requestId: input.requestId });

  if (token && (connection.status === "active" || connection.webhook_path_token)) {
    try {
      const lifecycle = createConnectionLifecycle(CHANNEL_CONNECTIONS.get("telegram"));
      const { data: allCapabilities } = await admin.from("telegram_bot_surface_capabilities")
        .select("surface, capability")
        .eq("organization_id", input.organizationId)
        .eq("connection_id", input.connection_id);
      const record = {
        provider: "telegram" as const,
        status: connection.status as "draft" | "configured" | "active" | "paused" | "disconnected" | "error" | "deleted",
        grants: Object.values((allCapabilities ?? []).reduce<Record<string, { surface: string; capabilities: string[] }>>((map, row) => {
          const binding = map[row.surface] ?? { surface: row.surface, capabilities: [] as string[] };
          (binding.capabilities as string[]).push(row.capability);
          map[row.surface] = binding;
          return map;
        }, {})),
      };
      const context = {
        organizationId: input.organizationId,
        connectionId: input.connection_id,
        actorUserId: input.actorUserId,
        expectedAccountId: connection.telegram_bot_id,
      };
      const deactivateDecision = await lifecycle.deactivate(context, record, input.action as "pause" | "disconnect" | "delete");
      if (!deactivateDecision.allowed) {
        return fail("state_conflict", "A conexão não pode ser alterada no estado atual.", 409, { requestId: input.requestId });
      }
    } catch {
      return fail("upstream_error", "Não foi possível remover o webhook no Telegram; o estado foi mantido.", 502, { requestId: input.requestId });
    }
  }

  if (input.action === "delete") {
    const tombstoneToken = randomBytes(48).toString("base64url");
    const tombstoneEncrypted = await encryptWebhookSecret(admin, tombstoneToken);
    if (!tombstoneEncrypted)
      return fail("unprocessable_entity", "Não foi possível remover a credencial da instalação com segurança.", 422, { requestId: input.requestId });
    const { error: markDisconnectedError } = await admin
      .from("telegram_bot_connections")
      .update({
        status: "deleted",
        deleted_at: new Date().toISOString(),
        token_encrypted: tombstoneEncrypted,
        token_last4: "----",
        webhook_path_token: null,
        webhook_secret_encrypted: null,
        updated_by: input.actorUserId,
      })
      .eq("organization_id", input.organizationId)
      .eq("id", input.connection_id);
    if (markDisconnectedError)
      return fail("internal_error", "O webhook foi removido, mas não foi possível registrar a exclusão.", 500, { requestId: input.requestId });
    await atualizarEstadoDaSessaoTelegram(admin, {
      organizationId: input.organizationId,
      connectionId: input.connection_id,
      status: "STOPPED",
      reason: "telegram_connection_deleted",
    });
  } else {
    const status = input.action === "pause" ? "paused" : "disconnected";
    const { error: updateError } = await admin
      .from("telegram_bot_connections")
      .update({
        status,
        webhook_path_token: null,
        webhook_secret_encrypted: null,
        updated_by: input.actorUserId,
      })
      .eq("organization_id", input.organizationId)
      .eq("id", input.connection_id);
    if (updateError)
      return fail("internal_error", "O webhook foi removido, mas não foi possível salvar o novo estado. Verifique a conexão antes de tentar novamente.", 500, { requestId: input.requestId });
    await atualizarEstadoDaSessaoTelegram(admin, {
      organizationId: input.organizationId,
      connectionId: input.connection_id,
      status: "STOPPED",
      reason: `telegram_${status}`,
    });
  }

  const actionByState = {
    pause: "telegram.bot_paused",
    disconnect: "telegram.bot_disconnected",
    delete: "telegram.bot_deleted",
  } as const;
  await audit({
    action: actionByState[input.action as keyof typeof actionByState],
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    resourceType: "telegram_bot_connection",
    resourceId: input.connection_id,
    requestId: input.requestId,
    metadata: { telegram_bot_id: connection.telegram_bot_id },
  });
  return ok({ status: input.action === "delete" ? "deleted" : input.action === "pause" ? "paused" : "disconnected" }, { requestId: input.requestId });
}
