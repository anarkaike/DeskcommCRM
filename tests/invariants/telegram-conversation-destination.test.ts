import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

function erroDe(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    const cause = error as { stderr?: Buffer | string; message?: string };
    return `${cause.stderr ?? ""}${cause.message ?? ""}`;
  }
  throw new Error("a função aceitou um destino Telegram inválido");
}

describe("Telegram Inbox: a conversa retém o destino de resposta", () => {
  it("o upsert grava o chat id e a repetição preserva a conversa e o mesmo destino", () => {
    const slug = `telegram-destination-${Date.now()}`;
    sql(`insert into public.organizations (slug, legal_name, display_name)
         values ('${slug}', 'Telegram Test', 'Telegram Test');`);
    const org = sql(`select id from public.organizations where slug = '${slug}'`).trim();
    const connection = sql(`with inserted as (insert into public.telegram_bot_connections (
        organization_id, telegram_bot_id, display_name, token_encrypted, token_last4, status
      ) values ('${org}', '123456789', 'Inbox Test', '\\x00'::bytea, '6789', 'configured')
      returning id) select id from inserted`).trim();
    const session = sql(`with inserted as (insert into public.channel_sessions (
        organization_id, provider, telegram_bot_connection_id, webhook_secret_encrypted,
        engine, phone_number, waha_session_name
      ) values ('${org}', 'telegram', '${connection}', '\\x00'::bytea, null, null, null)
      returning id) select id from inserted`).trim();
    const contact = sql(`with inserted as (insert into public.contacts (organization_id, source, social_identity, display_name)
      values ('${org}', 'telegram', 'telegram:99887766', 'Pessoa Telegram') returning id)
      select id from inserted`).trim();

    const first = sql(`select public.fn_upsert_telegram_conversation(
      '${org}', '${contact}', '${session}', '99887766'
    )`).trim();
    const second = sql(`select public.fn_upsert_telegram_conversation(
      '${org}', '${contact}', '${session}', '99887766'
    )`).trim();
    expect(second).toBe(first);
    expect(sql(`select provider_conversation_id from public.conversations where id = '${first}'`).trim())
      .toBe("99887766");
    expect(sql(`select count(*) from public.conversations where organization_id = '${org}' and channel_session_id = '${session}'`).trim())
      .toBe("1");
  });

  it("recusa um destino que não seja o identificador numérico aceito pelo Bot API", () => {
    const message = erroDe(() => sql(`select public.fn_upsert_telegram_conversation(
      gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'https://attacker.invalid'
    )`));
    expect(message).toContain("telegram_conversation_id_invalid");
  });
});
