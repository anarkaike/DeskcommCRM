-- manifest: Enable the isolated, read-only Telegram team case assistant.
alter table public.telegram_case_interactions
  drop constraint if exists telegram_case_interactions_action_check;

alter table public.telegram_case_interactions
  add constraint telegram_case_interactions_action_check
  check (action in ('list_open','list_closed','view_case','guide_reply','guide_question','resolve','escalate','approve_member','assistant_reply'));

comment on column public.telegram_team_group_settings.team_assistant_enabled is
  'Opt-in read-only assistant for verified members replying to case cards in this Telegram group; it cannot mutate cases or message customers.';
