-- manifest: **Grupos Telegram entram na Inbox por allowlist explícita.** IDs e títulos descobertos vêm de updates reais; conversas permanecem humanas e não acionam IA.

alter table public.channel_session_groups
  drop constraint if exists channel_session_groups_group_chat_id_check;
alter table public.channel_session_groups
  add constraint channel_session_groups_group_chat_id_check
  check (group_chat_id like '%@g.us' or group_chat_id ~ '^-?[0-9]{1,20}$');

drop function if exists public.fn_upsert_telegram_conversation(uuid, uuid, uuid, text);
create function public.fn_upsert_telegram_conversation(
  p_org uuid,
  p_contact uuid,
  p_session uuid,
  p_provider_conversation_id text,
  p_is_group boolean default false,
  p_group_chat_id text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_provider_conversation_id is null or p_provider_conversation_id !~ '^-?[0-9]{1,20}$' then
    raise exception 'telegram_conversation_id_invalid' using errcode = '22023';
  end if;
  if p_is_group and (p_group_chat_id is null or p_group_chat_id !~ '^-?[0-9]{1,20}$' or p_group_chat_id <> p_provider_conversation_id) then
    raise exception 'telegram_group_id_invalid' using errcode = '22023';
  end if;
  if not p_is_group and p_group_chat_id is not null then
    raise exception 'telegram_group_id_unexpected' using errcode = '22023';
  end if;

  if p_is_group then
    insert into public.conversations (
      organization_id, contact_id, channel_session_id, channel, status,
      is_group, group_chat_id, unread_count_for_assignee, provider_conversation_id
    ) values (
      p_org, p_contact, p_session, 'telegram', 'open', true, p_group_chat_id, 0, p_provider_conversation_id
    )
    on conflict (organization_id, contact_id, channel_session_id, group_chat_id)
    do update set provider_conversation_id = excluded.provider_conversation_id, updated_at = now()
    returning id into v_id;
  else
    insert into public.conversations (
      organization_id, contact_id, channel_session_id, channel, status,
      is_group, unread_count_for_assignee, provider_conversation_id
    ) values (
      p_org, p_contact, p_session, 'telegram', 'open', false, 0, p_provider_conversation_id
    )
    on conflict (organization_id, contact_id, channel_session_id) where is_group = false
    do update set
      provider_conversation_id = coalesce(conversations.provider_conversation_id, excluded.provider_conversation_id),
      updated_at = now()
    returning id into v_id;
  end if;
  return v_id;
end; $$;
revoke all on function public.fn_upsert_telegram_conversation(uuid, uuid, uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.fn_upsert_telegram_conversation(uuid, uuid, uuid, text, boolean, text) to service_role;

-- Compatibility facade for existing server callers; all behavior stays in the
-- six-argument implementation above.
create function public.fn_upsert_telegram_conversation(
  p_org uuid, p_contact uuid, p_session uuid, p_provider_conversation_id text
) returns uuid language sql security definer set search_path = public as $$
  select public.fn_upsert_telegram_conversation(
    p_org, p_contact, p_session, p_provider_conversation_id, false, null
  );
$$;
revoke all on function public.fn_upsert_telegram_conversation(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_upsert_telegram_conversation(uuid, uuid, uuid, text) to service_role;
