-- manifest: Short-lived signed transfers of private inbound message media to commercial integrations.
alter table public.organizations
  add column if not exists mcp_externo_artwork_encrypted bytea,
  add column if not exists mcp_externo_artwork_iv bytea,
  add column if not exists mcp_externo_artwork_tag bytea,
  add column if not exists mcp_externo_artwork_last4 text,
  add column if not exists mcp_externo_artwork_blog_id bigint;

comment on column public.organizations.mcp_externo_artwork_encrypted is
  'Encrypted HMAC key for private inbound media transfers; separate from MCP bearer and approval key.';
comment on column public.organizations.mcp_externo_artwork_blog_id is
  'WordPress blog ID authorized to consume artwork transfers for this organization.';

create table if not exists public.mcp_artwork_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  blog_id bigint not null check (blog_id > 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mcp_artwork_transfers_expiry_after_creation check (expires_at > created_at)
);

create index if not exists mcp_artwork_transfers_expiry_idx
  on public.mcp_artwork_transfers (expires_at);
create index if not exists mcp_artwork_transfers_scope_idx
  on public.mcp_artwork_transfers (organization_id, contact_id, conversation_id, message_id);

alter table public.mcp_artwork_transfers enable row level security;
revoke all on public.mcp_artwork_transfers from public, anon, authenticated;
grant select, insert, update, delete on public.mcp_artwork_transfers to service_role;
