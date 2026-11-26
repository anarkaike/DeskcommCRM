-- manifest: Registra aprovação segura de participantes Telegram como observadores e correlaciona callbacks de aprovação.
alter table public.telegram_team_group_members
  add column if not exists approval_state text not null default 'pending';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='telegram_team_group_members_approval_state_check'
      and conrelid='public.telegram_team_group_members'::regclass
  ) then
    alter table public.telegram_team_group_members
      add constraint telegram_team_group_members_approval_state_check
      check (approval_state in ('pending','approved','observer','denied'));
  end if;
end $$;

update public.telegram_team_group_members
   set approval_state=case when reviewed_at is not null then 'approved' else 'pending' end
 where approval_state='pending' and reviewed_at is not null;

alter table public.telegram_case_interactions
  add column if not exists target_telegram_user_id text
  check (target_telegram_user_id ~ '^[0-9]{1,20}$');

alter table public.telegram_case_interactions
  drop constraint if exists telegram_case_interactions_action_check;

alter table public.telegram_case_interactions
  add constraint telegram_case_interactions_action_check
  check (action in ('list_open','list_closed','view_case','guide_reply','guide_question','resolve','escalate','approve_member','deny_member','assistant_reply'));

comment on column public.telegram_team_group_members.approval_state is
  'Review state for an observed Telegram participant. Observers and denied members never receive CRM action grants.';
comment on column public.telegram_case_interactions.target_telegram_user_id is
  'Observed Telegram participant targeted by a short-lived approve/deny membership callback.';
