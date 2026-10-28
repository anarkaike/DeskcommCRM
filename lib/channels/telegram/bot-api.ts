import {
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  type FetchedMedia,
} from "@/lib/messaging/media/types";
import type { OutboundMedia } from "../types";
import { assertUrlDeMidiaSegura } from "@/lib/messaging/media/url-de-midia-externa";
import { env } from "@/lib/env";
import { fetchDoServidor } from "@/lib/supabase/fetch-do-servidor";
import { urlDoSupabaseNoServidor } from "@/lib/supabase/url-do-servidor";

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

function telegramTransportErrorCode(cause: unknown): string {
  let current: unknown = cause;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    if (
      "code" in current &&
      typeof current.code === "string" &&
      /^[A-Z0-9_]{1,40}$/.test(current.code)
    ) {
      return current.code;
    }
    current = "cause" in current ? current.cause : null;
  }
  return cause instanceof DOMException && cause.name === "TimeoutError"
    ? "TIMEOUT"
    : "FETCH_FAILED";
}

/** Só leituras podem repetir após falha de transporte. O mesmo signal limita
 * o prazo TOTAL das duas tentativas; envios nunca passam por este helper. */
async function fetchLeituraTelegram(url: string | URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    return fetch(url, init);
  }
}

function numericReplyId(value: string | null | undefined): number | null {
  if (!value || !/^\d{1,16}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Chamada comum à Bot API. Token não sai desta fronteira: erros expostos ao
 * restante do CRM recebem códigos estáveis e nunca incluem URL/body do provider.
 */
async function callTelegram<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const init: RequestInit = {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    };
    response =
      method === "getFile" ? await fetchLeituraTelegram(url, init) : await fetch(url, init);
  } catch (cause) {
    // Keep diagnostics useful in server logs without ever carrying the request
    // URL, which contains the bot token, into the error path.
    throw new Error(`telegram_network_error_${telegramTransportErrorCode(cause)}`);
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

async function lerCorpoLimitado(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new MediaTooLargeError();
  const reader = response.body?.getReader();
  if (!reader) throw new Error("telegram_media_download_failed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new MediaTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
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
    )
      return null;
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
    allowed_updates: input.allowedUpdates ?? [
      "message",
      "edited_message",
      "channel_post",
      "edited_channel_post",
      "callback_query",
      "chat_member",
      "my_chat_member",
    ],
    drop_pending_updates: false,
  });
  if (result !== true) throw new Error("telegram_webhook_rejected");
}

export async function deleteTelegramWebhook(token: string): Promise<void> {
  const result = await callTelegram<boolean>(token, "deleteWebhook", {
    drop_pending_updates: false,
  });
  if (result !== true) throw new Error("telegram_webhook_delete_rejected");
}

export async function getTelegramWebhookInfo(token: string): Promise<TelegramWebhookInfo> {
  const result = await callTelegram<Record<string, unknown>>(token, "getWebhookInfo");
  return {
    url: typeof result.url === "string" ? result.url : "",
    hasCustomCertificate: result.has_custom_certificate === true,
    pendingUpdateCount:
      typeof result.pending_update_count === "number" ? result.pending_update_count : 0,
    lastErrorDate: typeof result.last_error_date === "number" ? result.last_error_date : null,
    lastErrorMessage:
      typeof result.last_error_message === "string" ? result.last_error_message : null,
    maxConnections: typeof result.max_connections === "number" ? result.max_connections : null,
    allowedUpdates: Array.isArray(result.allowed_updates)
      ? result.allowed_updates.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

export async function sendTelegramText(input: {
  token: string;
  chatId: string;
  text: string;
  replyToMessageId?: string | null;
  inlineKeyboard?: TelegramInlineButton[][];
}): Promise<TelegramSentMessage> {
  const text = input.text.trim();
  if (!/^[-]?\d{1,20}$/.test(input.chatId) || !text || [...text].length > 4096) {
    throw new Error("telegram_message_invalid");
  }
  const replyId = numericReplyId(input.replyToMessageId);
  const keyboard = input.inlineKeyboard;
  if (
    keyboard &&
    (keyboard.length > 8 ||
      keyboard.some((row) => row.length < 1 || row.length > 8) ||
      keyboard
        .flat()
        .some(
          (button) =>
            !button.text.trim() ||
            button.text.length > 64 ||
            !/^[A-Za-z0-9_-]{1,64}$/.test(button.callbackData),
        ))
  ) {
    throw new Error("telegram_inline_keyboard_invalid");
  }
  const result = await callTelegram<Record<string, unknown>>(input.token, "sendMessage", {
    chat_id: input.chatId,
    text,
    ...(replyId ? { reply_parameters: { message_id: replyId } } : {}),
    ...(keyboard
      ? {
          reply_markup: {
            inline_keyboard: keyboard.map((row) =>
              row.map((button) => ({
                text: button.text,
                callback_data: button.callbackData,
              })),
            ),
          },
        }
      : {}),
  });
  const chat = result.chat as Record<string, unknown> | undefined;
  if (
    (typeof result.message_id !== "number" && typeof result.message_id !== "string") ||
    (typeof chat?.id !== "number" && typeof chat?.id !== "string") ||
    typeof result.date !== "number"
  )
    throw new Error("telegram_invalid_response");
  return { messageId: String(result.message_id), chatId: String(chat.id), date: result.date };
}

/** Acknowledge callback buttons quickly so Telegram stops showing a spinner. */
export async function answerTelegramCallbackQuery(input: {
  token: string;
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}): Promise<void> {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.callbackQueryId) ||
    (input.text && [...input.text].length > 200)
  ) {
    throw new Error("telegram_callback_invalid");
  }
  const result = await callTelegram<boolean>(input.token, "answerCallbackQuery", {
    callback_query_id: input.callbackQueryId,
    ...(input.text ? { text: input.text } : {}),
    ...(input.showAlert ? { show_alert: true } : {}),
  });
  if (result !== true) throw new Error("telegram_callback_ack_rejected");
}

export async function sendTelegramMedia(input: {
  token: string;
  chatId: string;
  kind: "image" | "video" | "audio" | "document";
  media: OutboundMedia;
  replyToMessageId?: string | null;
}): Promise<TelegramSentMessage> {
  if (!/^[-]?\d{1,20}$/.test(input.chatId)) throw new Error("telegram_message_invalid");
  const isVoice = input.kind === "audio" && input.media.mime === "audio/ogg";
  const isAudio =
    input.kind === "audio" && ["audio/mpeg", "audio/mp4", "audio/m4a"].includes(input.media.mime);
  const method =
    input.kind === "image"
      ? "sendPhoto"
      : input.kind === "video"
        ? "sendVideo"
        : isVoice
          ? "sendVoice"
          : isAudio
            ? "sendAudio"
            : "sendDocument";
  const field =
    input.kind === "image"
      ? "photo"
      : input.kind === "video"
        ? "video"
        : isVoice
          ? "voice"
          : isAudio
            ? "audio"
            : "document";
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(input.media.url);
  } catch {
    throw new Error("telegram_media_invalid_url");
  }
  if (sourceUrl.username || sourceUrl.password) throw new Error("telegram_media_invalid_url");
  try {
    await assertUrlDeMidiaSegura(sourceUrl.toString());
  } catch {
    throw new Error("telegram_media_invalid_url");
  }
  // URLs assinadas mantêm a origem pública; o servidor baixa pelo endereço
  // interno configurado, inclusive quando o Storage local usa HTTP.
  const fetchMedia = fetchDoServidor(
    urlDoSupabaseNoServidor(env.SUPABASE_SERVER_URL, env.NEXT_PUBLIC_SUPABASE_URL),
    env.NEXT_PUBLIC_SUPABASE_URL,
  );
  let source: Response;
  try {
    source = await fetchMedia(sourceUrl, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("telegram_media_source_unavailable");
  }
  if (!source.ok) throw new Error(`telegram_media_source_http_${source.status}`);
  const limit = input.kind === "image" ? 10_000_000 : 50_000_000;
  let bytes: Buffer;
  try {
    bytes = await lerCorpoLimitado(source, limit);
  } catch (cause) {
    if (cause instanceof MediaTooLargeError) throw cause;
    throw new Error("telegram_media_source_read_failed");
  }
  const caption = input.media.caption?.trim();
  const form = new FormData();
  form.set("chat_id", input.chatId);
  const fileBytes = new Uint8Array(bytes.byteLength);
  fileBytes.set(bytes);
  const mime = /^[A-Za-z0-9.+_-]+\/[A-Za-z0-9.+_-]+$/.test(input.media.mime)
    ? input.media.mime
    : "application/octet-stream";
  const ext = mime.split("/")[1]?.replace(/[^A-Za-z0-9_-]/g, "") || "bin";
  const fileName =
    input.media.filename
      ?.split(/[\\/]/)
      .pop()
      ?.replace(/[\r\n\u0000]/g, "")
      .slice(0, 128) || `telegram-upload.${ext}`;
  form.set(field, new Blob([fileBytes], { type: mime }), fileName);
  if (caption) form.set("caption", caption.slice(0, 1024));
  const replyId = numericReplyId(input.replyToMessageId);
  if (replyId) form.set("reply_parameters", JSON.stringify({ message_id: replyId }));
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${input.token}/${method}`, {
      method: "POST",
      body: form,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Fetch errors may include the request URL, which contains the bot token.
    throw new Error("telegram_network_error");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("telegram_invalid_response");
  }
  if (
    !response.ok ||
    !payload ||
    typeof payload !== "object" ||
    (payload as TelegramEnvelope<unknown>).ok !== true
  ) {
    throw new Error(`telegram_api_${response.status}`);
  }
  const result = (payload as { result: Record<string, unknown> }).result;
  const chat = result.chat as Record<string, unknown> | undefined;
  if (
    (typeof result.message_id !== "number" && typeof result.message_id !== "string") ||
    (typeof chat?.id !== "number" && typeof chat?.id !== "string") ||
    typeof result.date !== "number"
  )
    throw new Error("telegram_invalid_response");
  return { messageId: String(result.message_id), chatId: String(chat.id), date: result.date };
}

/** Download by provider file_id; never trusts a host or URL supplied by an update. */
export async function fetchTelegramMedia(input: {
  token: string;
  fileId: string;
  hintMime?: string | null;
}): Promise<FetchedMedia> {
  if (
    typeof input.fileId !== "string" ||
    !input.fileId ||
    input.fileId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(input.fileId)
  ) {
    throw new Error("telegram_media_invalid_ref");
  }
  const file = await callTelegram<{ file_path?: unknown; file_size?: unknown }>(
    input.token,
    "getFile",
    {
      file_id: input.fileId,
    },
  );
  if (
    typeof file.file_path !== "string" ||
    !/^[A-Za-z0-9_./-]+$/.test(file.file_path) ||
    file.file_path.startsWith("/") ||
    file.file_path.includes("..")
  ) {
    throw new Error("telegram_media_invalid_path");
  }
  if (
    typeof file.file_size === "number" &&
    file.file_size > Math.min(MAX_MEDIA_BYTES, 20_000_000)
  ) {
    throw new MediaTooLargeError();
  }
  const url = new URL(`/file/bot${input.token}/${file.file_path}`, "https://api.telegram.org");
  let response: Response;
  try {
    response = await fetchLeituraTelegram(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("telegram_media_download_failed");
  }
  if (!response.ok) throw new Error(`telegram_media_http_${response.status}`);
  const limit = Math.min(MAX_MEDIA_BYTES, 20_000_000);
  let buffer: Buffer;
  try {
    buffer = await lerCorpoLimitado(response, limit);
  } catch (cause) {
    if (cause instanceof MediaTooLargeError) throw cause;
    throw new Error("telegram_media_download_failed");
  }
  const contentType = response.headers.get("content-type")?.split(";")[0];
  const mime =
    !contentType || contentType === "application/octet-stream"
      ? input.hintMime || "application/octet-stream"
      : contentType;
  return { buffer, mime };
}
