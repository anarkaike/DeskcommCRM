-- manifest: Telegram team cases runtime.

alter table public.telegram_team_group_settings
  add column if not exists membership_attested_at timestamptz,
  add column if not exists membership_attested_by uuid references auth.users(id) on delete set null;

create table if not exists public.telegram_case_alert_config (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  group_setting_id uuid not null,
  enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_case_alert_config_group_fk foreign key (organization_id, group_setting_id)
    references public.telegram_team_group_settings (organization_id, id) on delete cascade
);

create table if not exists public.telegram_case_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  case_id uuid not null references public.agent_cases(id) on delete cascade,
  group_setting_id uuid not null,
  connection_id uuid not null,
  message_id text,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
  error_code text,
  attempts smallint not null default 0 check (attempts between 0 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint telegram_case_alert_deliveries_group_fk foreign key (organization_id, group_setting_id)
    references public.telegram_team_group_settings (organization_id, id) on delete cascade,
  constraint telegram_case_alert_deliveries_connection_fk foreign key (organization_id, connection_id)
    references public.telegram_bot_connections (organization_id, id) on delete cascade,
  constraint telegram_case_alert_deliveries_unique unique (organization_id, case_id, group_setting_id)
);

create table if not exists public.telegram_case_interactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  group_setting_id uuid not null,
  update_id bigint,
  telegram_user_id text not null check (telegram_user_id ~ '^[0-9]{1,20}$'),
  actor_user_id uuid references auth.users(id) on delete set null,
  case_id uuid references public.agent_cases(id) on delete set null,
  action text not null check (action in ('list_open','list_closed','view_case','guide_reply','guide_question','resolve','escalate','approve_member')),
  status text not null default 'received' check (status in ('received','confirmed','completed','rejected','expired')),
  callback_token_hash text unique,
  group_message_id text,
  reply_to_message_id text,
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint telegram_case_interactions_connection_fk foreign key (organization_id, connection_id)
    references public.telegram_bot_connections (organization_id, id) on delete cascade,
  constraint telegram_case_interactions_group_fk foreign key (organization_id, group_setting_id)
    references public.telegram_team_group_settings (organization_id, id) on delete cascade,
  constraint telegram_case_interactions_update_unique unique (connection_id, update_id)
);

create index if not exists telegram_case_alert_deliveries_pending_idx
  on public.telegram_case_alert_deliveries (organization_id, status, created_at);
create index if not exists telegram_case_interactions_expiry_idx
  on public.telegram_case_interactions (expires_at) where status in ('received','confirmed');

alter table public.telegram_case_alert_config enable row level security;
alter table public.telegram_case_alert_deliveries enable row level security;
alter table public.telegram_case_interactions enable row level security;
revoke all on public.telegram_case_alert_config, public.telegram_case_alert_deliveries, public.telegram_case_interactions from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_case_alert_config, public.telegram_case_alert_deliveries, public.telegram_case_interactions to service_role;

comment on column public.telegram_team_group_settings.membership_attested_at is
  'Explicit admin attestation of observed Telegram roster; Bot API cannot enumerate all group members. New membership event clears this attestation.';
comment on table public.telegram_case_alert_config is
  'Organization alert destination references canonical per-group settings; group permissions are not duplicated.';
comment on table public.telegram_case_alert_deliveries is
  'Idempotent minimal Telegram alert receipts; no case text, contact data or transcript.';
comment on table public.telegram_case_interactions is
  'Idempotent Telegram group action/callback correlation; no message body retained.';
