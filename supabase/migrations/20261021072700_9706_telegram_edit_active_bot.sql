-- manifest: Mantém o bot Telegram ativo ao salvar alterações de bindings e capacidades; edição não interrompe webhook nem sessão.
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
     set status = case when status = 'active' then 'active' else 'configured' end,
         updated_by = p_actor_user_id
   where organization_id = p_organization_id and id = p_connection_id;
  return true;
end;
$$;
revoke execute on function public.fn_telegram_bot_save_bindings(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fn_telegram_bot_save_bindings(uuid, uuid, jsonb, uuid) to service_role;
