-- manifest: Configura capacidades internas independentes por grupo Telegram sem alterar a allowlist da Inbox.
create unique index if not exists channel_session_groups_org_id_uidx
  on public.channel_session_groups (organization_id, id);

create table if not exists public.telegram_team_group_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  channel_session_group_id uuid not null,
  group_chat_id text not null check (group_chat_id ~ '^-?[0-9]{1,20}$'),
  case_alerts_enabled boolean not null default false,
  case_actions_enabled boolean not null default false,
  team_assistant_enabled boolean not null default false,
  membership_state text not null default 'unknown'
    check (membership_state in ('unknown','healthy','stale','suspended')),
  membership_checked_at timestamptz,
  membership_last_update_id bigint,
  assistant_disabled_reason text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_team_group_settings_connection_fk
    foreign key (organization_id, connection_id)
    references public.telegram_bot_connections (organization_id, id) on delete cascade,
  constraint telegram_team_group_settings_group_fk
    foreign key (organization_id, channel_session_group_id)
    references public.channel_session_groups (organization_id, id) on delete cascade,
  constraint telegram_team_group_settings_group_unique unique (organization_id, connection_id, group_chat_id),
  constraint telegram_team_group_settings_row_unique unique (organization_id, id)
);

create table if not exists public.telegram_team_group_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_setting_id uuid not null,
  telegram_user_id text not null check (telegram_user_id ~ '^[0-9]{1,20}$'),
  paired_user_id uuid references auth.users(id) on delete set null,
  display_name text,
  username text,
  membership_status text not null default 'unknown'
    check (membership_status in ('unknown','member','left','restricted')),
  observed_at timestamptz not null default now(),
  last_update_id bigint,
  can_use_assistant boolean not null default false,
  can_act_on_cases boolean not null default false,
  can_approve_members boolean not null default false,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_team_group_members_setting_fk
    foreign key (organization_id, group_setting_id)
    references public.telegram_team_group_settings (organization_id, id) on delete cascade,
  constraint telegram_team_group_members_identity_unique
    unique (organization_id, group_setting_id, telegram_user_id)
);

create index if not exists telegram_team_group_settings_org_idx
  on public.telegram_team_group_settings (organization_id, connection_id);
create index if not exists telegram_team_group_members_lookup_idx
  on public.telegram_team_group_members (organization_id, group_setting_id, membership_status);

alter table public.telegram_team_group_settings enable row level security;
alter table public.telegram_team_group_members enable row level security;
revoke all on public.telegram_team_group_settings from public, anon, authenticated;
revoke all on public.telegram_team_group_members from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_team_group_settings to service_role;
grant select, insert, update, delete on public.telegram_team_group_members to service_role;

drop policy if exists telegram_team_group_settings_select on public.telegram_team_group_settings;
create policy telegram_team_group_settings_select on public.telegram_team_group_settings
  for select to authenticated
  using (organization_id in (
    select org_id from public.fn_user_org_ids() org_id
    where public.fn_user_role_in_org(org_id) in ('manager','admin')
  ));
drop policy if exists telegram_team_group_members_select on public.telegram_team_group_members;
create policy telegram_team_group_members_select on public.telegram_team_group_members
  for select to authenticated
  using (organization_id in (
    select org_id from public.fn_user_org_ids() org_id
    where public.fn_user_role_in_org(org_id) in ('manager','admin')
  ));

comment on table public.telegram_team_group_settings is
  'Canonical internal-capability settings per Telegram group; channel_session_groups.enabled remains only the Inbox allowlist.';
comment on column public.telegram_team_group_settings.membership_state is
  'Security state. AI and case writes require healthy; Telegram Bot API does not provide a complete member inventory.';
