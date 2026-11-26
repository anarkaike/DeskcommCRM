-- manifest: Permite IDs numéricos de grupos Telegram na tabela compartilhada de grupos de sessão.
alter table public.channel_session_groups
  drop constraint if exists channel_session_groups_group_chat_id_check;
alter table public.channel_session_groups
  add constraint channel_session_groups_group_chat_id_check
  check (group_chat_id like '%@g.us' or group_chat_id ~ '^-?[0-9]{1,20}$');
