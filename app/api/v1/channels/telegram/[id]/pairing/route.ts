import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id: rawId } = await context.params;
  const parsedId = z.string().uuid().safeParse(rawId);
  if (!parsedId.success) return fail("validation_error", "Identificador de bot inválido.", 422, { requestId });
  const id = parsedId.data;
  const authz = await requireRole("agent", { requestId, resource: "telegram_case_operator" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const admin = createAdminClient();
  const { data: connection, error } = await admin.from("telegram_bot_connections")
    .select("id, status, bot_username")
    .eq("organization_id", authz.org.orgId).eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) return fail("internal_error", "Não foi possível verificar o bot Telegram.", 500, { requestId });
  if (!connection || connection.status !== "active") return fail("state_conflict", "Ative o bot antes de parear um operador.", 409, { requestId });
  const { data: capabilities, error: capabilityError } = await admin.from("telegram_bot_surface_capabilities")
    .select("capability").eq("organization_id", authz.org.orgId).eq("connection_id", id).eq("surface", "human_cases");
  if (capabilityError) return fail("internal_error", "Não foi possível verificar a superfície de casos.", 500, { requestId });
  const grants = new Set((capabilities ?? []).map((row: { capability: string }) => row.capability));
  if (!grants.has("read_cases") || !grants.has("reply_to_cases")) {
    return fail("forbidden", "Habilite leitura e resposta de casos nas configurações do bot.", 403, { requestId });
  }

  const code = randomBytes(18).toString("base64url");
  const codeHash = createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const { error: clearError } = await admin.from("telegram_case_pairing_challenges").delete()
    .eq("organization_id", authz.org.orgId).eq("connection_id", id).eq("user_id", authz.user.id);
  if (clearError) return fail("internal_error", "Não foi possível substituir um código anterior.", 500, { requestId });
  const { error: insertError } = await admin.from("telegram_case_pairing_challenges").insert({
    organization_id: authz.org.orgId, connection_id: id, user_id: authz.user.id, code_hash: codeHash,
    expires_at: expiresAt,
  });
  if (insertError) return fail("internal_error", "Não foi possível gerar o código de pareamento.", 500, { requestId });
  await audit({
    action: "telegram.case_operator_pairing_requested", actorUserId: authz.user.id,
    organizationId: authz.org.orgId, resourceType: "telegram_bot_connection", resourceId: id, requestId,
  });
  return ok({
    code, expires_at: expiresAt,
    command: `/parear ${code}`, bot_username: connection.bot_username,
  }, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id: rawId } = await context.params;
  const parsedId = z.string().uuid().safeParse(rawId);
  if (!parsedId.success) return fail("validation_error", "Identificador de bot inválido.", 422, { requestId });
  const authz = await requireRole("agent", { requestId, resource: "telegram_case_operator" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const admin = createAdminClient();
  const { data: removed, error } = await admin.from("telegram_case_operators")
    .update({ revoked_at: new Date().toISOString() })
    .eq("organization_id", authz.org.orgId).eq("connection_id", parsedId.data)
    .eq("user_id", authz.user.id).is("revoked_at", null).select("id");
  if (error) return fail("internal_error", "Não foi possível remover o pareamento Telegram.", 500, { requestId });
  if (removed?.length) {
    await audit({
      action: "telegram.case_operator_unpaired", actorUserId: authz.user.id,
      organizationId: authz.org.orgId, resourceType: "telegram_bot_connection",
      resourceId: parsedId.data, requestId,
    });
  }
  return ok({ unpaired: Boolean(removed?.length) }, { requestId });
}
