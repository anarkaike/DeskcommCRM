-- manifest: Metadados mínimos dos bots Telegram ficam legíveis para membros do tenant via RLS, sem expor tokens cifrados.

-- O seletor de canais usa o cliente autenticado. A tabela de bots continua sem
-- privilégio de SELECT amplo: só os metadados usados pelo filtro podem ser lidos.
-- `token_encrypted` e demais colunas de credencial permanecem exclusivos da
-- service_role.
revoke select on public.telegram_bot_connections from anon, authenticated;
grant select (id, organization_id, status, deleted_at)
  on public.telegram_bot_connections to authenticated;

drop policy if exists telegram_bot_connections_select_tenant on public.telegram_bot_connections;
create policy telegram_bot_connections_select_tenant
  on public.telegram_bot_connections
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

-- As capacidades não são segredo, mas continuam isoladas por organização.
revoke select on public.telegram_bot_surface_capabilities from anon, authenticated;
grant select (organization_id, connection_id, surface, capability)
  on public.telegram_bot_surface_capabilities to authenticated;

drop policy if exists telegram_bot_surface_capabilities_select_tenant
  on public.telegram_bot_surface_capabilities;
create policy telegram_bot_surface_capabilities_select_tenant
  on public.telegram_bot_surface_capabilities
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
