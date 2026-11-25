/**
 * De onde sai o identificador da sessão/número no provider.
 *
 * Esta é a pergunta que NÃO pode viver numa feature: com dois providers o
 * `sessionRef` vem de `waha_session_name` **ou** de `meta_phone_number_id`, e
 * quem escolher isso fora daqui vira o `if (provider === ...)` que o invariante
 * 1 da doutrina existe para proibir. O chamador pede o ref; a coluna é detalhe.
 *
 * O tipo é a tagged union que a migration 0087 já enforça no banco
 * (`channel_sessions_provider_ref_check`): a coluna do provider da vez é NOT
 * NULL, a do outro é NULL. Por isso o retorno é `string`, não `string | null` —
 * a garantia é do CHECK, não de otimismo.
 */
export type ChannelSessionRef =
  | { provider: "waha"; waha_session_name: string }
  | { provider: "meta_cloud"; meta_phone_number_id: string }
  | { provider: "zernio" | "zernio_social"; zernio_account_id: string }
  | { provider: "datafy"; datafy_phone_number_id: string }
  | { provider: "telegram"; telegram_bot_id: string }
  | { provider: "telegram"; telegram_bot_connection_id: string }
  /** Chat no site: a chave pública da conexão identifica o widget. */
  | { provider: "webchat"; webchat_public_key: string };

/**
 * Colunas que um `select` do PostgREST precisa trazer para `resolveSessionRef`
 * funcionar. Fica aqui pelo mesmo motivo da função: a string do `select` também
 * nomeia coluna de provider, e ela some da feature junto com a decisão.
 */
export const CHANNEL_SESSION_REF_COLUMNS =
  "provider, waha_session_name, meta_phone_number_id, zernio_account_id, datafy_phone_number_id, telegram_bot_id, telegram_bot_connection_id, webchat_public_key";

export function resolveSessionRef(session: ChannelSessionRef): string {
  switch (session.provider) {
    case "meta_cloud":
      return session.meta_phone_number_id;
    // O `phone_number_id` da WABA, como no canal oficial — mas pela coluna do
    // parceiro, porque os dois podem conviver e endereçam servidores diferentes.
    case "datafy":
      return session.datafy_phone_number_id;
    case "waha":
      return session.waha_session_name;
    // O bot do Telegram não endereça por telefone: o id do robô é a chave que a
    // Bot API conhece e que a sessão guarda (migration 9342).
    case "telegram":
      return "telegram_bot_connection_id" in session
        ? session.telegram_bot_connection_id
        : session.telegram_bot_id;
    // O chat no site endereça pela chave pública da conexão (`wck_…`), que o
    // widget carrega e a rota pública confere contra a linha.
    case "webchat":
      return session.webchat_public_key;
    // O `accountId` que o provider devolve ao conectar a WABA. NÃO é o
    // phone_number_id da Meta: quem intermedeia guarda o número por dentro e
    // endereça pelo id dele. Mandar o id da Meta aqui responde 404.
    case "zernio_social":
    case "zernio":
      return session.zernio_account_id;
  }
}
