import type { SupabaseClient } from "@supabase/supabase-js";

export async function prepararSessaoTelegram(
  admin: SupabaseClient,
  input: { organizationId: string; connectionId: string; displayName: string; actorUserId: string; encryptedSecret: string },
): Promise<boolean> {
  const { data: session, error: lookupError } = await admin.from("channel_sessions")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("telegram_bot_connection_id", input.connectionId)
    .maybeSingle();
  if (lookupError) return false;
  if (session) {
    const { error } = await admin.from("channel_sessions")
      .update({ status: "STOPPED", status_reason: "telegram_webhook_pending", webhook_secret_encrypted: input.encryptedSecret })
      .eq("id", session.id).eq("organization_id", input.organizationId);
    return !error;
  }
  const { error } = await admin.from("channel_sessions").insert({
    organization_id: input.organizationId,
    telegram_bot_connection_id: input.connectionId,
    provider: "telegram",
    waha_session_name: null,
    engine: null,
    phone_number: null,
    display_name: input.displayName,
    webhook_secret_encrypted: input.encryptedSecret,
    status: "STOPPED",
    status_reason: "telegram_webhook_pending",
    created_by: input.actorUserId,
  } as never);
  return !error;
}

export async function atualizarEstadoDaSessaoTelegram(
  admin: SupabaseClient,
  input: { organizationId: string; connectionId: string; status: "WORKING" | "STOPPED"; reason: string | null; encryptedSecret?: string },
): Promise<boolean> {
  const { error } = await admin.from("channel_sessions").update({
    status: input.status,
    status_reason: input.reason,
    ...(input.encryptedSecret ? { webhook_secret_encrypted: input.encryptedSecret } : {}),
  }).eq("organization_id", input.organizationId).eq("telegram_bot_connection_id", input.connectionId);
  return !error;
}
