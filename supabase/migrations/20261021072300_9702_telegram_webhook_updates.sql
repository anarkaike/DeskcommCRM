-- manifest: **Entrada autenticada e idempotente de updates Telegram.** Persiste o payload para consumo/reprocessamento antes de responder 200 ao Telegram.

create table if not exists public.telegram_webhook_updates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  update_id bigint not null,
  update_type text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint telegram_webhook_updates_connection_org_fk
    foreign key (organization_id, connection_id)
    references public.telegram_bot_connections (organization_id, id) on delete cascade,
  constraint telegram_webhook_updates_status_check
    check (status in ('pending', 'processing', 'processed', 'ignored', 'error')),
  constraint telegram_webhook_updates_attempts_check check (attempts >= 0),
  constraint telegram_webhook_updates_connection_update_unique unique (connection_id, update_id)
);

create index if not exists telegram_webhook_updates_pending_idx
  on public.telegram_webhook_updates (received_at, id)
  where status in ('pending', 'error');
create index if not exists telegram_webhook_updates_org_connection_idx
  on public.telegram_webhook_updates (organization_id, connection_id, received_at desc);

alter table public.telegram_webhook_updates enable row level security;
revoke all on public.telegram_webhook_updates from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_webhook_updates to service_role;
comment on table public.telegram_webhook_updates is
  'Fila durável e idempotente dos updates aceitos pelo webhook Telegram. Payload tem dados pessoais e só é acessível via service_role; consumidores devem apagar/reter conforme política LGPD.';

