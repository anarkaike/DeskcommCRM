import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { validateTelegramBotToken } from "@/lib/channels/telegram/bot-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const surfaceNames = ["inbox", "team_alerts", "human_cases", "agent_tools", "mini_app"] as const;
const capabilitiesBySurface = {
  inbox: ["receive_messages", "human_replies", "ai_replies", "proactive_send", "group_messages"],
  team_alerts: ["send_alerts"],
  human_cases: ["read_cases", "reply_to_cases"],
  agent_tools: ["tool_read", "tool_write"],
  mini_app: ["mini_app_access"],
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
    return fail("state_conflict", "Este bot já está cadastrado nesta organização.", 409, {
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
  const parsed = settingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_error", "As opções de uso do bot são inválidas.", 422, { requestId });

  const admin = createAdminClient();
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
