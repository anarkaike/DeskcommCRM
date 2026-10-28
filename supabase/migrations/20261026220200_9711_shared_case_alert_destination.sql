-- manifest: use one canonical case-alert destination for WhatsApp or a Telegram team group.
alter table public.config_aviso_de_caso
  add column if not exists destino_tipo text not null default 'whatsapp',
  add column if not exists telegram_group_setting_id uuid;

alter table public.config_aviso_de_caso
  alter column telefone_destino drop not null;

alter table public.config_aviso_de_caso
  drop constraint if exists config_aviso_de_caso_destino_tipo_check;
alter table public.config_aviso_de_caso
  add constraint config_aviso_de_caso_destino_tipo_check
  check (destino_tipo in ('whatsapp','telegram'));

alter table public.config_aviso_de_caso
  drop constraint if exists config_aviso_de_caso_telegram_group_fk;
alter table public.config_aviso_de_caso
  add constraint config_aviso_de_caso_telegram_group_fk
  foreign key (organization_id, telegram_group_setting_id)
  references public.telegram_team_group_settings(organization_id, id)
  on delete set null (telegram_group_setting_id);

alter table public.config_aviso_de_caso
  drop constraint if exists config_aviso_de_caso_destination_shape;
alter table public.config_aviso_de_caso
  add constraint config_aviso_de_caso_destination_shape check (
    (destino_tipo='whatsapp' and telegram_group_setting_id is null
      and (telefone_destino is not null or ligado=false))
    or
    (destino_tipo='telegram' and channel_session_id is null and telefone_destino is null
      and destino_jid is null and resposta_whatsapp_habilitada=false
      and (telegram_group_setting_id is not null or ligado=false))
  );

create or replace function public.fn_aviso_de_caso_coerente()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.channel_session_id is not null or new.telefone_destino is not null then
    new.destino_tipo := 'whatsapp';
    new.telegram_group_setting_id := null;
  end if;
  if new.destino_tipo = 'telegram' then
    new.channel_session_id := null;
    new.telefone_destino := null;
    new.destino_jid := null;
    new.resposta_whatsapp_habilitada := false;
    if new.telegram_group_setting_id is null then
      new.ligado := false;
    end if;
  else
    new.telegram_group_setting_id := null;
    if new.channel_session_id is null or new.telefone_destino is null then
      new.ligado := false;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_aviso_de_caso_coerente() from public, anon, authenticated;

-- Migrate the earlier Telegram-only pointer into the same canonical row.
do $$
declare
  r record;
begin
  if to_regclass('public.telegram_case_alert_config') is not null then
    for r in execute 'select organization_id, group_setting_id, enabled, updated_by from public.telegram_case_alert_config' loop
      if r.enabled then
        insert into public.config_aviso_de_caso
          (organization_id, destino_tipo, telegram_group_setting_id, channel_session_id,
           telefone_destino, destino_jid, rotulo, ligado, resposta_whatsapp_habilitada,
           criado_por, atualizado_por)
        values
          (r.organization_id, 'telegram', r.group_setting_id, null, null, null, null, true, false,
           r.updated_by, r.updated_by)
        on conflict (organization_id) do update set
          destino_tipo='telegram', telegram_group_setting_id=excluded.telegram_group_setting_id,
          channel_session_id=null, telefone_destino=null, destino_jid=null,
          resposta_whatsapp_habilitada=false, ligado=true, atualizado_por=excluded.atualizado_por,
          updated_at=now();
      end if;
    end loop;
    drop table public.telegram_case_alert_config;
  end if;
end;
$$;

create or replace function public.fn_definir_aviso_de_caso_telegram(
  p_org uuid,
  p_group_setting_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group public.telegram_team_group_settings;
begin
  if auth.uid() is null or p_org is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'aviso_de_caso_forbidden' using errcode = '42501';
  end if;
  if not public.fn_session_mfa_proven() then
    raise exception 'aviso_de_caso_mfa_required' using errcode = '42501';
  end if;

  if p_group_setting_id is not null then
    select t.* into v_group
      from public.telegram_team_group_settings t
      join public.telegram_bot_connections c
        on c.organization_id=t.organization_id and c.id=t.connection_id
     where t.organization_id=p_org and t.id=p_group_setting_id
       and t.case_alerts_enabled=true and t.membership_state='healthy'
       and t.membership_attested_at is not null and c.status='active' and c.deleted_at is null
       and exists (
         select 1 from public.telegram_bot_surface_capabilities x
          where x.organization_id=t.organization_id and x.connection_id=t.connection_id
            and x.surface='team_alerts' and x.capability='send_alerts'
       )
     for update of t;
    if not found then
      raise exception 'telegram_case_alert_group_ineligible' using errcode = '22023';
    end if;
  end if;

  insert into public.config_aviso_de_caso
    (organization_id,destino_tipo,telegram_group_setting_id,channel_session_id,
     telefone_destino,destino_jid,rotulo,ligado,resposta_whatsapp_habilitada,
     criado_por,atualizado_por)
  values
    (p_org,'telegram',p_group_setting_id,null,null,null,null,p_group_setting_id is not null,false,auth.uid(),auth.uid())
  on conflict (organization_id) do update set
    destino_tipo='telegram', telegram_group_setting_id=excluded.telegram_group_setting_id,
    channel_session_id=null, telefone_destino=null, destino_jid=null, rotulo=null,
    ligado=excluded.ligado, resposta_whatsapp_habilitada=false,
    atualizado_por=auth.uid(), updated_at=now();

  return jsonb_build_object('saved',true,'destino_tipo','telegram','group_setting_id',p_group_setting_id);
end;
$$;
revoke all on function public.fn_definir_aviso_de_caso_telegram(uuid,uuid) from public, anon;
grant execute on function public.fn_definir_aviso_de_caso_telegram(uuid,uuid) to authenticated;

comment on column public.config_aviso_de_caso.destino_tipo is
  'Canonical case-alert destination kind; both WhatsApp and Telegram settings use this single organization row.';
comment on column public.config_aviso_de_caso.telegram_group_setting_id is
  'Selected Telegram team group when destino_tipo=telegram; group capabilities remain on telegram_team_group_settings.';
