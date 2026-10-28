-- manifest: Servinder WooCommerce MCP uses a separate encrypted secret to sign customer-confirmed writes. Bearer credential and approval authority remain independent.
alter table public.organizations
  add column if not exists mcp_externo_aprovacao_encrypted bytea,
  add column if not exists mcp_externo_aprovacao_iv bytea,
  add column if not exists mcp_externo_aprovacao_tag bytea,
  add column if not exists mcp_externo_aprovacao_last4 text;

comment on column public.organizations.mcp_externo_aprovacao_encrypted is
  'MCP external HMAC approval key encrypted with AES-256-GCM, independent from bearer token.';
comment on column public.organizations.mcp_externo_aprovacao_iv is
  'AES-GCM IV for the MCP external HMAC approval key.';
comment on column public.organizations.mcp_externo_aprovacao_tag is
  'AES-GCM tag for the MCP external HMAC approval key.';
comment on column public.organizations.mcp_externo_aprovacao_last4 is
  'Last four characters of the HMAC approval key, partial identifier only.';

notify pgrst, 'reload schema';
