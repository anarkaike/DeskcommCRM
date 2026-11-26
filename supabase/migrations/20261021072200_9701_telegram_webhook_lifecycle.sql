-- manifest: **Ciclo de vida do webhook por bot Telegram.** Persiste apenas o token de caminho opaco e o segredo de verificação cifrado; ativa/pausa/desconecta sem descartar updates pendentes.

alter table public.telegram_bot_connections
  add column if not exists webhook_path_token text,
  add column if not exists webhook_secret_encrypted bytea,
  add column if not exists webhook_last_error text,
  add column if not exists webhook_last_error_at timestamptz,
  add column if not exists webhook_connected_at timestamptz;

alter table public.telegram_bot_connections
  drop constraint if exists telegram_bot_connections_status_check;
alter table public.telegram_bot_connections
  add constraint telegram_bot_connections_status_check
  check (status in ('draft', 'configured', 'active', 'paused', 'disconnected', 'error'));

create unique index if not exists telegram_bot_connections_webhook_path_unique
  on public.telegram_bot_connections (webhook_path_token)
  where webhook_path_token is not null;
-- Um bot só pode ter UM webhook na Bot API; aceitar o mesmo token em dois
-- tenants faria a última ativação sequestrar silenciosamente o recebimento.
create unique index if not exists telegram_bot_connections_bot_global_unique
  on public.telegram_bot_connections (telegram_bot_id);

comment on column public.telegram_bot_connections.webhook_path_token is
  'Segredo aleatório de URL para resolver webhook do bot; nunca retornado na API autenticada.';
comment on column public.telegram_bot_connections.webhook_secret_encrypted is
  'secret_token do header X-Telegram-Bot-Api-Secret-Token cifrado com fn_encrypt_oauth.';

