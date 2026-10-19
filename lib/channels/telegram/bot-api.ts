export interface TelegramBotIdentity {
  id: string;
  username: string | null;
  firstName: string;
}

export interface TelegramWebhookInfo {
  url: string;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
  lastErrorDate: number | null;
  lastErrorMessage: string | null;
  maxConnections: number | null;
  allowedUpdates: string[];
}

export interface TelegramSentMessage {
  messageId: string;
  chatId: string;
  date: number;
}

type TelegramEnvelope<T> = { ok: true; result: T } | { ok: false; description?: string };

const API_TIMEOUT_MS = 8_000;

/**
 * Chamada comum à Bot API. Token não sai desta fronteira: erros expostos ao
 * restante do CRM recebem códigos estáveis e nunca incluem URL/body do provider.
 */
async function callTelegram<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw new Error("telegram_network_error");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("telegram_invalid_response");
  }
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error(`telegram_http_${response.status}`);
  }
  const envelope = payload as TelegramEnvelope<T>;
  if (envelope.ok !== true) {
    // Não repassamos `description`: alguns erros podem conter contexto remoto
    // que não deve virar log ou mensagem de UI sem sanitização.
    throw new Error(`telegram_api_${response.status}`);
  }
  return envelope.result;
}

/**
 * Confere a credencial com getMe. A URL do Bot API contém o token por contrato;
 * ela fica exclusivamente no servidor, nunca é registrada nem devolvida.
 */
export async function validateTelegramBotToken(token: string): Promise<TelegramBotIdentity | null> {
  try {
    const bot = await callTelegram<{
      id?: unknown;
      is_bot?: unknown;
      username?: unknown;
      first_name?: unknown;
    }>(token, "getMe");
    if (
      bot.is_bot !== true ||
      (typeof bot.id !== "number" && typeof bot.id !== "string") ||
      !/^\d{1,20}$/.test(String(bot.id)) ||
      typeof bot.first_name !== "string"
    ) return null;
    return {
      id: String(bot.id),
      username: typeof bot.username === "string" ? bot.username : null,
      firstName: bot.first_name,
    };
  } catch {
    return null;
  }
}

export async function setTelegramWebhook(input: {
  token: string;
  url: string;
  secretToken: string;
    allowedUpdates?: string[];
}): Promise<void> {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("telegram_webhook_url_invalid");
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(input.secretToken)) {
    throw new Error("telegram_webhook_secret_invalid");
  }
  const result = await callTelegram<boolean>(input.token, "setWebhook", {
    url: url.toString(),
    secret_token: input.secretToken,
    allowed_updates: input.allowedUpdates ?? ["message"],
    drop_pending_updates: false,
  });
  if (result !== true) throw new Error("telegram_webhook_rejected");
}

export async function deleteTelegramWebhook(token: string): Promise<void> {
  const result = await callTelegram<boolean>(token, "deleteWebhook", { drop_pending_updates: false });
  if (result !== true) throw new Error("telegram_webhook_delete_rejected");
}

export async function getTelegramWebhookInfo(token: string): Promise<TelegramWebhookInfo> {
  const result = await callTelegram<Record<string, unknown>>(token, "getWebhookInfo");
  return {
    url: typeof result.url === "string" ? result.url : "",
    hasCustomCertificate: result.has_custom_certificate === true,
    pendingUpdateCount: typeof result.pending_update_count === "number" ? result.pending_update_count : 0,
    lastErrorDate: typeof result.last_error_date === "number" ? result.last_error_date : null,
    lastErrorMessage: typeof result.last_error_message === "string" ? result.last_error_message : null,
    maxConnections: typeof result.max_connections === "number" ? result.max_connections : null,
    allowedUpdates: Array.isArray(result.allowed_updates)
      ? result.allowed_updates.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export async function sendTelegramText(input: {
  token: string;
  chatId: string;
  text: string;
  replyToMessageId?: string | null;
}): Promise<TelegramSentMessage> {
  const text = input.text.trim();
  if (!/^[-]?\d{1,20}$/.test(input.chatId) || !text || [...text].length > 4096) {
    throw new Error("telegram_message_invalid");
  }
  const result = await callTelegram<Record<string, unknown>>(input.token, "sendMessage", {
    chat_id: input.chatId,
    text,
    ...(input.replyToMessageId ? { reply_parameters: { message_id: Number(input.replyToMessageId) } } : {}),
  });
  const chat = result.chat as Record<string, unknown> | undefined;
  if (
    (typeof result.message_id !== "number" && typeof result.message_id !== "string") ||
    (typeof chat?.id !== "number" && typeof chat?.id !== "string") ||
    typeof result.date !== "number"
  ) throw new Error("telegram_invalid_response");
  return { messageId: String(result.message_id), chatId: String(chat.id), date: result.date };
}
