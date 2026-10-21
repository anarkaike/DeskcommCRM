-- manifest: **O destino de resposta Telegram fica na conversa.** A Inbox monta o adapter a partir de conversations.provider_conversation_id; sem persistir o chat_id ali, toda resposta humana era recusada como destinatário ausente.

drop function if exists public.fn_upsert_telegram_conversation(uuid, uuid, uuid);

create or replace function public.fn_upsert_telegram_conversation(
  p_org uuid, p_contact uuid, p_session uuid, p_provider_conversation_id text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_provider_conversation_id is null or p_provider_conversation_id !~ '^-?[0-9]{1,20}$' then
    raise exception 'telegram_conversation_id_invalid' using errcode = '22023';
  end if;
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
  return v_id;
end; $$;
revoke all on function public.fn_upsert_telegram_conversation(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_upsert_telegram_conversation(uuid, uuid, uuid, text) to service_role;
