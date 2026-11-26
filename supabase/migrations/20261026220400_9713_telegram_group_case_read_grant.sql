-- manifest: Separe consulta de casos das permissões de resposta para permitir operadores observadores em grupos Telegram.
alter table public.telegram_team_group_members
  add column if not exists can_read_cases boolean not null default false;

-- Preserva acesso de leitura já implícito para quem podia agir antes desta granularidade.
update public.telegram_team_group_members
   set can_read_cases=true
 where can_act_on_cases=true and can_read_cases=false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname='telegram_team_group_members_act_requires_read'
       and conrelid='public.telegram_team_group_members'::regclass
  ) then
    alter table public.telegram_team_group_members
      add constraint telegram_team_group_members_act_requires_read
      check (not can_act_on_cases or can_read_cases);
  end if;
end $$;

comment on column public.telegram_team_group_members.can_read_cases is
  'Allows a paired, reviewed operator to list and inspect cases in this group without permission to act on them.';
