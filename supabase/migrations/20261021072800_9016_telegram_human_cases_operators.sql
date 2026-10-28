-- manifest: Pareia operadores Telegram a usuários ativos do tenant para consulta e resposta auditável de casos humanos.
create table if not exists public.telegram_case_pairing_challenges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint telegram_case_pairing_challenges_connection_fk
    foreign key (organization_id, connection_id)
    references public.telegram_bot_connections (organization_id, id) on delete cascade
);
create index if not exists telegram_case_pairing_challenges_lookup_idx
  on public.telegram_case_pairing_challenges (organization_id, connection_id, code_hash, expires_at)
  where consumed_at is null;

create table if not exists public.telegram_case_operators (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  telegram_user_id text not null check (telegram_user_id ~ '^[0-9]{1,20}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  paired_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint telegram_case_operators_connection_fk
    foreign key (organization_id, connection_id)
    references public.telegram_bot_connections (organization_id, id) on delete cascade,
  constraint telegram_case_operators_identity_unique unique (organization_id, connection_id, telegram_user_id)
);
create index if not exists telegram_case_operators_active_idx
  on public.telegram_case_operators (organization_id, connection_id, telegram_user_id)
  where revoked_at is null;
create unique index if not exists telegram_case_operators_active_user_unique
  on public.telegram_case_operators (organization_id, connection_id, user_id)
  where revoked_at is null;

alter table public.telegram_case_pairing_challenges enable row level security;
alter table public.telegram_case_operators enable row level security;
revoke all on public.telegram_case_pairing_challenges from public, anon, authenticated;
revoke all on public.telegram_case_operators from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_case_pairing_challenges to service_role;
grant select, insert, update, delete on public.telegram_case_operators to service_role;

create or replace function public.fn_telegram_case_operator_pair(
  p_organization_id uuid, p_connection_id uuid, p_code_hash text, p_telegram_user_id text
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_challenge public.telegram_case_pairing_challenges%rowtype;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_telegram_user_id !~ '^[0-9]{1,20}$' then return null; end if;
  select ch.* into v_challenge
    from public.telegram_case_pairing_challenges ch
    join public.user_organizations u on u.organization_id=ch.organization_id and u.user_id=ch.user_id
      and u.revoked_at is null and u.role in ('agent','manager','admin')
    join public.telegram_bot_connections c on c.organization_id=ch.organization_id and c.id=ch.connection_id
      and c.status='active' and c.deleted_at is null
   where ch.organization_id=p_organization_id and ch.connection_id=p_connection_id
     and ch.code_hash=p_code_hash and ch.consumed_at is null and ch.expires_at>now()
     and exists (
       select 1 from public.telegram_bot_bindings b
        join public.telegram_bot_surface_capabilities sc
          on sc.organization_id=b.organization_id and sc.connection_id=b.connection_id and sc.surface=b.surface
        where b.organization_id=p_organization_id and b.connection_id=p_connection_id and b.surface='human_cases'
        group by b.connection_id
        having bool_or(sc.capability='read_cases') and bool_or(sc.capability='reply_to_cases')
     )
   order by ch.created_at desc limit 1 for update of ch;
  if not found then return null; end if;
  update public.telegram_case_pairing_challenges set consumed_at=now()
   where id=v_challenge.id and consumed_at is null;
  if not found then return null; end if;
  update public.telegram_case_operators set revoked_at=now()
   where organization_id=p_organization_id and connection_id=p_connection_id and user_id=v_challenge.user_id
     and revoked_at is null and telegram_user_id<>p_telegram_user_id;
  insert into public.telegram_case_operators (organization_id,connection_id,telegram_user_id,user_id,paired_at,revoked_at)
  values (p_organization_id,p_connection_id,p_telegram_user_id,v_challenge.user_id,now(),null)
  on conflict (organization_id,connection_id,telegram_user_id)
  do update set user_id=excluded.user_id,paired_at=now(),revoked_at=null;
  return v_challenge.user_id;
end;
$$;
revoke execute on function public.fn_telegram_case_operator_pair(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.fn_telegram_case_operator_pair(uuid,uuid,text,text) to service_role;
