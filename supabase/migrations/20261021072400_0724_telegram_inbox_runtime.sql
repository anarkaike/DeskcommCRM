-- manifest: **Canal Telegram no ledger compartilhado da Inbox.** Cria sessão
-- sem número/engine WAHA, identidade opaca de contato e conversa `telegram`;
-- não habilita grupos, IA nem envio proativo.

alter table public.channel_sessions add column if not exists telegram_bot_connection_id uuid;
alter table public.channel_sessions alter column engine drop not null;
alter table public.telegram_webhook_updates add column if not exists processing_at timestamptz;
alter table public.telegram_webhook_updates drop constraint if exists telegram_webhook_updates_status_check;
alter table public.telegram_webhook_updates add constraint telegram_webhook_updates_status_check
  check (status in ('pending', 'processing', 'processed', 'ignored', 'error', 'deferred'));
alter table public.telegram_bot_connections add column if not exists deleted_at timestamptz;
alter table public.telegram_bot_connections drop constraint if exists telegram_bot_connections_status_check;
alter table public.telegram_bot_connections add constraint telegram_bot_connections_status_check
  check (status in ('draft', 'configured', 'active', 'paused', 'disconnected', 'error', 'deleted'));
drop index if exists public.telegram_bot_connections_bot_global_unique;
create unique index if not exists telegram_bot_connections_bot_global_unique
  on public.telegram_bot_connections (telegram_bot_id) where deleted_at is null;
drop index if exists public.telegram_bot_connections_org_bot_unique;
create unique index if not exists telegram_bot_connections_org_bot_unique
  on public.telegram_bot_connections (organization_id, telegram_bot_id) where deleted_at is null;
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions add constraint channel_sessions_provider_check
  check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'telegram'));
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
  (provider = 'waha' and waha_session_name is not null) or
  (provider = 'meta_cloud' and meta_phone_number_id is not null) or
  (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
  (provider = 'wacalls' and wacalls_session_id is not null) or
  (provider = 'datafy' and datafy_phone_number_id is not null) or
  (provider = 'telegram' and telegram_bot_connection_id is not null and phone_number is null)
);
create unique index if not exists channel_sessions_telegram_connection_unique
  on public.channel_sessions (telegram_bot_connection_id) where telegram_bot_connection_id is not null;
do $$ begin
  alter table public.channel_sessions add constraint channel_sessions_telegram_connection_fk
    foreign key (organization_id, telegram_bot_connection_id)
    references public.telegram_bot_connections (organization_id, id) on delete restrict;
exception when duplicate_object then null; end $$;

alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check
  check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram'));

create or replace function public.fn_upsert_telegram_contact(
  p_org uuid, p_identity text, p_display_name text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.contacts (organization_id, source, social_identity, display_name, source_metadata)
  values (p_org, 'telegram', p_identity, nullif(p_display_name, ''), jsonb_build_object('telegram', true))
  on conflict (organization_id, social_identity) where social_identity is not null and is_merged_into is null
  do update set display_name = coalesce(contacts.display_name, excluded.display_name), updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.fn_upsert_telegram_contact(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_upsert_telegram_contact(uuid, text, text) to service_role;

create or replace function public.fn_upsert_telegram_conversation(
  p_org uuid, p_contact uuid, p_session uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee)
  values (p_org, p_contact, p_session, 'telegram', 'open', false, 0)
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
  do update set updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.fn_upsert_telegram_conversation(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_upsert_telegram_conversation(uuid, uuid, uuid) to service_role;
