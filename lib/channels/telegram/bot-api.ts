export interface TelegramBotIdentity {
  id: string;
  username: string | null;
  firstName: string;
}

/**
 * Confere a credencial com getMe. A URL do Bot API contém o token por contrato;
 * ela fica exclusivamente no servidor, nunca é registrada nem devolvida.
 */
export async function validateTelegramBotToken(token: string): Promise<TelegramBotIdentity | null> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const data = payload as {
    ok?: unknown;
    result?: { id?: unknown; username?: unknown; first_name?: unknown };
  };
  const bot = data.result;
  if (
    data.ok !== true ||
    !bot ||
    (typeof bot.id !== "number" && typeof bot.id !== "string") ||
    !/^\d{1,20}$/.test(String(bot.id)) ||
    typeof bot.first_name !== "string"
  ) {
    return null;
  }
  return {
    id: String(bot.id),
    username: typeof bot.username === "string" ? bot.username : null,
    firstName: bot.first_name,
  };
}
