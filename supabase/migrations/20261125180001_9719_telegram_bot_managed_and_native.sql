-- manifest: O provider `telegram` aceita os dois adaptadores do repositório:
-- o canal nativo do Bot API (`telegram_bot_id`, migration 9342) e a integração
-- gerenciada do fork (`telegram_bot_connection_id`, migrations 9700–9716).
-- A migration 9342 passou a exigir `telegram_bot_id` depois de a 9703 já ter
-- definido o identificador próprio da conexão gerenciada. A constraint precisa
-- aceitar uma ou outra chave e continuar exigindo ausência de telefone.

do $$
begin
  alter table public.channel_sessions
    drop constraint if exists channel_sessions_provider_ref_check;

  alter table public.channel_sessions
    add constraint channel_sessions_provider_ref_check check (
      (provider = 'waha' and waha_session_name is not null) or
      (provider = 'meta_cloud' and meta_phone_number_id is not null) or
      (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
      (provider = 'wacalls' and wacalls_session_id is not null) or
      (provider = 'datafy' and datafy_phone_number_id is not null) or
      (provider = 'telegram' and phone_number is null and
        (telegram_bot_id is not null or telegram_bot_connection_id is not null)) or
      (provider = 'webchat' and webchat_public_key is not null)
    );
end
$$;
