import type { ChannelConnectionDriver, ChannelConnectionHealth } from "../connection-types";
import { deleteTelegramWebhook, getTelegramWebhookInfo, validateTelegramBotToken } from "./bot-api";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDoWebhookTelegram } from "@/lib/webhooks/url-publica";

/** Protocol edge for the Telegram bot connection lifecycle. */
export const telegramConnectionDriver: ChannelConnectionDriver<string> = {
  provider: "telegram",
  async validateCredential(token) {
    const identity = await validateTelegramBotToken(token);
    return identity ? { providerAccountId: identity.id, displayName: identity.firstName, username: identity.username } : null;
  },
  async activate(context) {
    // Webhook URL and secret are connection-scoped and installed by the
    // application service after persisting the path token. Verify that the
    // registered credential still belongs to this immutable provider identity.
    if (!context.expectedAccountId) throw new Error("telegram_expected_bot_identity_missing");
    const admin = createAdminClient();
    const { data, error } = await admin.from("telegram_bot_connections")
      .select("token_encrypted")
      .eq("organization_id", context.organizationId)
      .eq("id", context.connectionId)
      .maybeSingle();
    if (error || !data) throw new Error("telegram_connection_lookup_failed");
    const token = await decryptWebhookSecret(admin, String(data.token_encrypted));
    const identity = token ? await this.validateCredential(token) : null;
    if (!identity || identity.providerAccountId !== context.expectedAccountId) throw new Error("telegram_bot_identity_mismatch");
  },
  async deactivate(context) {
    if (!context.expectedAccountId) throw new Error("telegram_expected_bot_identity_missing");
    if (context.action === "pause" && context.currentStatus !== "active") throw new Error("telegram_invalid_lifecycle_transition");
    const admin = createAdminClient();
    const { data, error } = await admin.from("telegram_bot_connections")
      .select("token_encrypted")
      .eq("organization_id", context.organizationId)
      .eq("id", context.connectionId)
      .maybeSingle();
    if (error || !data) throw new Error("telegram_connection_lookup_failed");
    const token = await decryptWebhookSecret(admin, String(data.token_encrypted));
    if (!token) throw new Error("telegram_connection_credential_unavailable");
    if (!context.expectedAccountId) throw new Error("telegram_expected_bot_identity_missing");
    const identity = await this.validateCredential(token);
    if (!identity || identity.providerAccountId !== context.expectedAccountId) throw new Error("telegram_bot_identity_mismatch");
    await deleteTelegramWebhook(token);
  },
  async health(context): Promise<ChannelConnectionHealth> {
    const checkedAt = new Date().toISOString();
    const admin = createAdminClient();
    const { data, error } = await admin.from("telegram_bot_connections")
      .select("token_encrypted, status, webhook_path_token, telegram_bot_id")
      .eq("organization_id", context.organizationId)
      .eq("id", context.connectionId)
      .maybeSingle();
    if (error || !data) return { healthy: false, checkedAt, state: "unknown", detailCode: "connection_unavailable" };
    if (data.status !== "active") return { healthy: false, checkedAt, state: "disconnected", detailCode: "connection_inactive" };
    const token = await decryptWebhookSecret(admin, String(data.token_encrypted));
    if (!token) return { healthy: false, checkedAt, state: "degraded", detailCode: "credential_unavailable" };
    try {
      const identity = await this.validateCredential(token);
      if (!identity || identity.providerAccountId !== data.telegram_bot_id) {
        return { healthy: false, checkedAt, state: "degraded", detailCode: "credential_identity_mismatch" };
      }
      const info = await getTelegramWebhookInfo(token);
      const expectedUrl = context.request && data.webhook_path_token
        ? `${basePublicaDoWebhookTelegram(context.request)}/api/v1/webhooks/telegram/${data.webhook_path_token}`
        : null;
      const webhookMatches = Boolean(expectedUrl && info.url === expectedUrl);
      return {
        healthy: webhookMatches && !info.lastErrorMessage,
        checkedAt,
        state: webhookMatches && !info.lastErrorMessage ? "connected" : "degraded",
        pendingCount: info.pendingUpdateCount,
        lastErrorAt: info.lastErrorDate === null ? null : new Date(info.lastErrorDate * 1000).toISOString(),
        webhookMatches,
        ...(info.lastErrorMessage ? { detailCode: "webhook_delivery_error" } : info.url !== expectedUrl ? { detailCode: "webhook_target_mismatch" } : {}),
      };
    } catch {
      return { healthy: false, checkedAt, state: "unknown", detailCode: "health_check_failed" };
    }
  },
};
