-- manifest: **Registro isolado de bots Telegram por tenant.** Guarda tokens cifrados e bindings de produto em domínio próprio; conexão validada ainda não ativa webhook nem concede papel ou acesso a dados.

create table if not exists public.telegram_bot_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  telegram_bot_id text not null,
  bot_username text,
  display_name text not null,
  token_encrypted bytea not null,
  token_last4 text not null,
  status text not null default 'draft',
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_bot_connections_id_org_unique unique (organization_id, id),
  constraint telegram_bot_connections_bot_id_format check (telegram_bot_id ~ '^[0-9]{1,20}$'),
  constraint telegram_bot_connections_status_check check (status in ('draft', 'configured', 'paused', 'error'))
);

create unique index if not exists telegram_bot_connections_org_bot_unique
  on public.telegram_bot_connections (organization_id, telegram_bot_id);
create index if not exists telegram_bot_connections_org_status_idx
  on public.telegram_bot_connections (organization_id, status, created_at desc);

comment on table public.telegram_bot_connections is
  'Conexões de bots Bot API Telegram, próprias por organização. Token cifrado por fn_encrypt_oauth e nunca devolvido ao browser. Status configured significa apenas cadastro e bindings salvos; não implica webhook ou envio ativo.';
comment on column public.telegram_bot_connections.telegram_bot_id is
  'ID remoto retornado por getMe, mantido como texto para evitar truncamento/conversão de precisão entre runtimes.';
comment on column public.telegram_bot_connections.token_encrypted is
  'Token Bot API cifrado por fn_encrypt_oauth. Só service_role acessa a linha; nunca selecionar esta coluna para resposta de API.';
comment on column public.telegram_bot_connections.token_last4 is
  'Sufixo curto para identificar a credencial sem revelar o token completo.';

alter table public.telegram_bot_connections enable row level security;
revoke all on public.telegram_bot_connections from anon, authenticated;
grant select, insert, update, delete on public.telegram_bot_connections to service_role;

drop trigger if exists trg_telegram_bot_connections_updated_at on public.telegram_bot_connections;
create trigger trg_telegram_bot_connections_updated_at
  before update on public.telegram_bot_connections
  for each row execute function public.fn_set_updated_at();

create table if not exists public.telegram_bot_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  surface text not null,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_bot_bindings_connection_org_fk
    foreign key (organization_id, connection_id)
    references public.telegram_bot_connections (organization_id, id) on delete cascade,
  constraint telegram_bot_bindings_surface_check
    check (surface in ('inbox', 'team_alerts', 'human_cases', 'agent_tools', 'mini_app')),
  constraint telegram_bot_bindings_org_connection_surface_unique unique (organization_id, connection_id, surface)
);

create index if not exists telegram_bot_bindings_org_surface_idx
  on public.telegram_bot_bindings (organization_id, surface, connection_id);

comment on table public.telegram_bot_bindings is
  'Associação configurada entre conexão Telegram e superfície DeskcommCRM. Binding não concede papel, não habilita capacidade especial e só produz efeito quando existir consumidor/runtime correspondente.';

alter table public.telegram_bot_bindings enable row level security;
revoke all on public.telegram_bot_bindings from anon, authenticated;
grant select, insert, update, delete on public.telegram_bot_bindings to service_role;

drop trigger if exists trg_telegram_bot_bindings_updated_at on public.telegram_bot_bindings;
create trigger trg_telegram_bot_bindings_updated_at
  before update on public.telegram_bot_bindings
  for each row execute function public.fn_set_updated_at();

create table if not exists public.telegram_bot_surface_capabilities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  surface text not null,
  capability text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint telegram_bot_surface_capabilities_binding_fk
    foreign key (organization_id, connection_id, surface)
    references public.telegram_bot_bindings (organization_id, connection_id, surface) on delete cascade,
  constraint telegram_bot_surface_capabilities_pair_check check (
    (surface = 'inbox' and capability in ('receive_messages', 'human_replies', 'ai_replies', 'proactive_send', 'group_messages')) or
    (surface = 'team_alerts' and capability in ('send_alerts')) or
    (surface = 'human_cases' and capability in ('read_cases', 'reply_to_cases')) or
    (surface = 'agent_tools' and capability in ('tool_read', 'tool_write')) or
    (surface = 'mini_app' and capability in ('mini_app_access'))
  ),
  constraint telegram_bot_surface_capabilities_unique unique (connection_id, surface, capability)
);

create index if not exists telegram_bot_surface_capabilities_org_idx
  on public.telegram_bot_surface_capabilities (organization_id, connection_id, surface);

comment on table public.telegram_bot_surface_capabilities is
  'Capacidades explicitamente concedidas ao binding de uma conexão Telegram. Ausência significa desabilitado; permissões administrativas de plataforma não são representáveis aqui.';

alter table public.telegram_bot_surface_capabilities enable row level security;
revoke all on public.telegram_bot_surface_capabilities from anon, authenticated;
grant select, insert, update, delete on public.telegram_bot_surface_capabilities to service_role;

create or replace function public.fn_telegram_bot_save_bindings(
  p_organization_id uuid,
  p_connection_id uuid,
  p_bindings jsonb,
  p_actor_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_binding jsonb;
  v_capability jsonb;
  v_surface text;
begin
  if jsonb_typeof(p_bindings) is distinct from 'array' then
    raise exception 'bindings_must_be_array' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.telegram_bot_connections c
     where c.organization_id = p_organization_id and c.id = p_connection_id
  ) then
    raise exception 'telegram_connection_not_found' using errcode = 'P0002';
  end if;

  delete from public.telegram_bot_bindings
   where organization_id = p_organization_id and connection_id = p_connection_id;

  for v_binding in select value from jsonb_array_elements(p_bindings)
  loop
    v_surface := v_binding ->> 'surface';
    if jsonb_typeof(v_binding -> 'capabilities') is distinct from 'array' then
      raise exception 'capabilities_must_be_array' using errcode = '22023';
    end if;
    insert into public.telegram_bot_bindings (
      organization_id, connection_id, surface, created_by, updated_by
    ) values (
      p_organization_id, p_connection_id, v_surface, p_actor_user_id, p_actor_user_id
    );
    for v_capability in select value from jsonb_array_elements(v_binding -> 'capabilities')
    loop
      insert into public.telegram_bot_surface_capabilities (
        organization_id, connection_id, surface, capability, created_by
      ) values (
        p_organization_id, p_connection_id, v_surface, v_capability #>> '{}', p_actor_user_id
      );
    end loop;
  end loop;

  update public.telegram_bot_connections
     set status = 'configured', updated_by = p_actor_user_id
   where organization_id = p_organization_id and id = p_connection_id;
  return true;
end;
$$;
revoke execute on function public.fn_telegram_bot_save_bindings(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fn_telegram_bot_save_bindings(uuid, uuid, jsonb, uuid) to service_role;
