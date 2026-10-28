# Extensões — contratos técnicos, dados e interfaces de execução

Companheiro do [desenho de produto](2026-10-26-extensoes-plataforma-design.md). Todos os nomes novos, DDLs e tipos abaixo são **PROPOSTOS**, não arquivos ou tabelas já existentes. Base: WSL `f702a018e`, 26/10/2026. O implementador deve conferir a última definição das funções do baseline e a árvore compartilhada antes de cada onda. Não copiar SQL deste documento direto para produção: completar grants, backfill, validação de constraints, migração e testes em banco isolado.

## 1. Mapa de arquivos e responsabilidades

| Local existente                                                          | Alteração proposta                                                                                         | Arquivos novos por responsabilidade                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `lib/extensions/manifest.ts`, `requests.ts`, `capacidades.ts`            | manter decoder v1 fechado; adicionar dispatcher de formato e catálogo de grants                            | `manifest-v2.ts`, `package-format.ts`, `permissions.ts`, `slots.ts`                                      |
| `lib/extensions/service.ts`, `http.ts`, `view.ts`                        | extrair aplicação independente de sessão, DTOs distintos, manter adapters de API v1                        | `application.ts`, `actor.ts`, `policy.ts`, `plans.ts`, `execution.ts`, `history.ts`                      |
| `lib/extensions/download.ts`                                             | reusar/preservar pinning DNS, limites, TLS e erro seguro; provider autenticado não usa fetch irrestrito    | `sources.ts`, `network.ts`, `artifact-store.ts`, `zip.ts`, `releases.ts`, `review.ts`                    |
| `lib/modulos/dados/{nome,tabela,paineis}.ts`                             | resolver identidade completa, registro de objetos e organização; não `.limit(1)` por slug ambíguo          | `lib/extensions/data/{registry,fields,crud,schema-plan,privacy}.ts`                                      |
| `components/extensions/` e `app/app/extensions/`                         | evoluir hub atual; marketplace/versões/permissões/histórico no mesmo produto                               | `Marketplace.tsx`, `OperationPlan.tsx`, `VersionHistory.tsx`, `PermissionConsent.tsx`, `DraftEditor.tsx` |
| `app/admin/(protected)/tenants/[id]/` e navegação admin                  | aba por tenant e política de rede; listar alterações com contexto                                          | `app/admin/(protected)/extensions/` e componentes próprios                                               |
| `lib/mcp/{types,auth,server}.ts`, `tools/index.ts`, `tools/catalogo/`    | separar principal tenant de plataforma; catálogo de autoria não exposto ao conversador                     | `tools/extensions.ts`, `tools/catalogo/extensions.ts`, `lib/extensions/publication-grants.ts`            |
| `lib/api/auth-dual.ts`, `lib/auth/public-paths.ts`                       | habilitar por rota com auth real; não tornar todo `/extensions` anônimo                                    | `lib/extensions/auth.ts`; resolver de bearer administrativo de plataforma separado                       |
| `lib/event-log/register-handlers.ts`, `workers/`, cron/scheduler         | handlers de processamento/retry e update; só eventos com efeito                                            | `lib/extensions/jobs.ts`, `events.ts`, `delivery.ts`, `updates.ts`                                       |
| `lib/navigation/catalogo.ts`, `components/admin/AdminSidebar.tsx`        | portas alcançáveis com papel certo                                                                         | entradas genéricas, sem um arquivo novo de rota por extensão                                             |
| `lib/audit/actions.ts`, `lib/i18n/dicionario.ts`, traduções              | vocabulário compartilhado e mensagens acionáveis                                                           | rótulos/code map de extensões/licenças/loja                                                              |
| `supabase/migrations/`, `supabase/baseline.sql`, `lib/database.types.ts` | migrations futuras sem números reservados aqui; regenerar tipos                                            | RPCs novas por onda, apêndices idênticos                                                                 |
| `lib/cobranca/`                                                          | manter assinatura SaaS separada de licenças; avaliar extrair transporte quando houver 2 consumidores reais | `lib/extension-commerce/` para ofertas/pedidos/licenças/revenda                                          |
| `app/api/v1/products/`, `lib/mcp/tools/comercio.ts`, RAG                 | projetar oferta autorizada em produto/FAQ; preço ao vivo                                                   | `lib/extension-commerce/product-projection.ts`, `knowledge.ts`, `sales-tools.ts`                         |
| scripts e guias                                                          | CLI fino e validador/generator do parser real, sem SQL direto                                              | `scripts/deskcomm-extensoes.ts`, `scripts/empacotar-extensao.ts`, exemplos/README de SDK futuro          |

Evitar ampliar `service.ts` indefinidamente. Regra pura em policy/solver; acesso a dados via repositórios; efeitos de rede/Storage em adapters; autorização é verificada outra vez no ponto do efeito. Não importar cookie/`next/headers` no núcleo de aplicação utilizado por MCP/worker.

## 2. Identidade e compatibilidade de formatos

### 2.1 Três identidades separadas

1. Identidade comercial global do produto: emissor/titular + produto, estável entre versões e revendedores.
2. Identidade técnica local: fonte confiável + publicador + nome, com `installation_id` estável. Um slug não é uma chave global.
3. Artefato: digest dos bytes publicados. Reutilizar bytes entre fontes não concede os direitos de uma fonte à outra.

Um catálogo legado mantém `catalog_id`, seus IDs e registros. Para v2, `source_id` representa a origem/autoridade, e `release_id` referencia artefato e versão. O hash pode deduplicar armazenamento físico, mas autorização é pela associação à release e direitos; nunca por saber o hash ou path de Storage.

### 2.2 Dispatch de manifesto

```ts
// PROPOSTO: manter o tipo v1 e seu parser, sem relaxar strict().
type SupportedManifest = LegacyExtensionManifest | ExtensionManifestV2;
type ExtensionManifestV2 = {
  format_version: 2;
  profile: "declarative" | "data" | "connected"; // adicionar connected só quando onda própria estiver pronta
  publisher: string;
  name: string;
  version: string;
  code_license: { spdx: string | null; custom_terms_ref?: string };
  host_api: { min: number; max: number };
  schema: { version: number; readable_min: number; readable_max: number };
  permissions: string[]; // valores do registro FECHADO do host, não qualquer string no decoder
  dependencies: Array<{
    source_ref: string;
    publisher: string;
    name: string;
    version_range: string;
    optional: boolean;
    required_contracts: Array<{ name: string; version_range: string }>;
  }>;
  display: {/* união localizada e ícones já contratados, ampliados com prova */};
  data: DeclaredDataV2 | { mode: "none" };
  configuration: { schema_version: number; fields: ConfigurationField[] };
  contributions: HostContributionsV2;
};
```

`spdx`/termos jurídicos não é pagamento. Ficha comercial, URL de compra, preço, revenda, update endpoint e homepage permanecem metadados de catálogo/fonte revisados; não permitir que manifesto altere secretamente o destino de rede. Preservar política MIT do v1. Licenças de código diferentes são revisão deliberada do contrato v2; nunca reclassificar pacote MIT como proprietário por cobrança.

Parser v2 limita e valida todas as chaves, UTF-8, números seguros, Unicode, árvores e nomes. `parseStrictJson` continua sendo entrada única para JSON não confiável. SQL deve revalidar propriedades relevantes ao efeito, não confiar em DTO já validado em TS. Erros de campo incluem caminhos legíveis e códigos estáveis, sem eco de conteúdo sensível.

Formato de pacote ZIP v2 proposto: raiz com `extension.json` e diretórios allowlisted `docs/`, `assets/`, `declarations/`. O inventário enumera arquivos/digests/mime/tamanho. Nenhuma URL de execução ou código livre em `assets`. Primeiro aceitar só imagem raster/ícone do host e textos; SVG/HTML exigem pipeline específico e podem ficar recusados. Bibliotecas de ZIP existentes podem ser avaliadas, mas suporte a descompressão não prova resistência a ZIP bomb.

## 3. Tipos de aplicação e plano de mudança

```ts
// Contexto produzido pelo servidor, nunca aceito como argumento livre de tool.
type ExtensionActor =
  | {
      kind: "tenant_user";
      actorId: string;
      organizationId: string;
      role: Role;
      tokenId?: string;
      scopes: readonly string[];
      via: "session" | "api" | "mcp";
    }
  | {
      kind: "platform_user";
      actorId: string;
      platformGrantId: string;
      targetOrganizationId?: string;
      tokenId?: string;
      scopes: readonly string[];
      via: "session" | "api" | "mcp";
    }
  | {
      kind: "local_policy_job";
      jobId: string;
      policyId: string;
      policyRevision: number;
      initiatingActorId: string;
    };

type ExtensionPlan = {
  id: string;
  revision: number;
  operation: string;
  actorId: string;
  target: { scope: "platform" | "organization"; organizationId: string | null };
  installationRevisions: Array<{ id: string; expected: number }>;
  releases: Array<{ id: string; sha256: string; version: string }>;
  dependencyLock: DependencyLock;
  policyRevision: number;
  permissionsAdded: string[];
  permissionsRemoved: string[];
  affectedOrganizations: { count: number; selectionDigest: string };
  dataImpact: SchemaPlan;
  backupRequirement: "artifact_only" | "scoped_snapshot" | "instance_backup";
  expiresAt: string;
  digest: string;
};
```

Novos tipos são esqueleto: completar campos e schemas Zod antes do primeiro consumidor. Nunca `as unknown as` para fingir que token tenant contém autoridade de plataforma. O job local carrega a referência de uma política, não privilégios vitalícios copiados do usuário.

Planejar e confirmar são operações separadas. Confirmar envia ID/digest/revisão do plano, não uma descrição de natural language que o servidor “entende”. A autorização do plano inclui efeito, alvo, artefatos, alterações de schema/permissões e revisões. Validade/revisão mudou → `extension_plan_stale`, sem efeito parcial. Expirar grant impede iniciar novo efeito; operação em andamento precisa revalidar antes de publicar ponteiros. A política de finalização ou cancelamento após expiração deve ser consistente e explícita; default proposto: completar preparação sem publicar e pedir nova autorização.

## 4. Persistência — manter tabelas existentes e acrescentar apenas domínios necessários

### 4.1 DIRC antes de schema

- `extension_artifacts` já é arquivo JSON imutável: mantê-lo como manifesto original legível, não duplicar manifesto normalizado como verdade concorrente.
- `extension_installations` já é o ponteiro vigente: mantê-lo como ponto de verdade para pacote instalado.
- `organization_extensions` já é ativação/configuração: ampliá-lo com consentimento/config versionada; não criar `tenant_plugins` paralelo.
- `extension_operations` já é recibo: expandir vocabulário/escopo cuidadosamente; não instalar por outro ledger separado.
- Política global pode usar `platform_config` existente; organizar JSON versionado e CAS em serviço próprio. Tabela tenant é justificável por RLS e overrides explícitos.
- Produtos já existem em `catalog_products`; usar FK e projeção. Pedidos comerciais de extensão são domínio novo: não misturar import de Nuvemshop com emissão de licença sem uma integração explícita.
- Credenciais remotas cifradas pertencem a uma conexão server-only; não JSON de configuração entregue ao frontend.

### 4.2 Schema proposto por grupo

Os schemas seguintes são contratos de campos e invariantes; números de migration/timestamps serão alocados na execução e checados contra a base e mudanças em voo. Tabelas tenant-aware levam `organization_id NOT NULL`, FK com cascata de organização onde a retenção permitir e RLS. Tabelas de plataforma abaixo são classificadas explicitamente e não recebem policy genérica tenant por acidente.

**A. Fontes, releases, blobs e política**

| Tabela                            | Escopo                             | Campos mínimos / constraints                                                                                                                                                                                                                                                                          |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension_sources`               | plataforma, metadado compartilhado | `id`, `kind` (`legacy_catalog`,`local_upload`,`remote_catalog`,`deskcomm_store`), `canonical_url` nullable só local, `issuer`, `status`, `trust_level`, `reviewed_by/at`, `revision`, `created_at`; URL sem credencial, identidade única por emissor/contexto. Não guardar token nesta tabela visível |
| `organization_extension_sources`  | tenant                             | `organization_id`, `source_id`, `visibility`, `allowed`, `revision`, `added_by/at`; PK composta; concessão e UI filtram tenant                                                                                                                                                                        |
| `extension_source_credentials`    | tenant/server-only                 | `organization_id`, `source_id`, `connection_id`, segredo cifrado ou referência no cofre; zero SELECT por PostgREST não privilegiado                                                                                                                                                                   |
| `extension_releases`              | plataforma com acesso mediado      | `id`, `source_id`, `publisher`, `name`, `version`, `artifact_id`, `package_sha256`, `published_at`, `uploaded_by`, `origin_kind`, `status` (`quarantined`,`validated`,`reviewed`,`rejected`,`withdrawn`), `review_revision`, `content_inventory`; unique `(source_id,publisher,name,version)`         |
| `extension_artifact_files`        | plataforma/server-only             | `artifact_id`, `kind` (`original_zip`,`inventory`,`asset`), `storage_key`, `sha256`, `byte_length`, `media_type`; unique `(artifact_id,kind,storage_key)`; arquivos autorizados pela release, não digest                                                                                              |
| `organization_extension_policies` | tenant                             | `organization_id` PK, `overrides` JSON fechado e versionado, `revision`, `updated_by/at`; null/ausente significa herdar, false significa negar                                                                                                                                                        |
| `extension_release_visibility`    | acesso a metadado de plataforma    | `(release_id, organization_id)` para pacote privado; sem linha = não visível salvo público/aprovado por política; usar tabela tenant-aware com org NOT NULL                                                                                                                                           |
| `extension_dependency_edges`      | plataforma/server-only             | `release_id`, `dependency_source_id`, `publisher`, `name`, `version_range`, `optional`, `required_contracts`; unique pela identidade requerida; sem endpoint de SQL livre                                                                                                                             |

Releases não se tornam visíveis a toda rede quando tenant envia ZIP. Artefato privado recém-enviado exige vínculo de visibilidade e namespace de publicação conferido. O pacote pode ser tecnicamente registrado por serviço da instância em nome do tenant, mas esse serviço aplica a política e não concede ao usuário papel de plataforma.

**B. Adaptação das tabelas legadas**

- `extension_catalogs`: adicionar `source_id` nullable durante backfill; criar fonte legado por `origin`; conservar `origin` unique e snapshots v1 intactos.
- `extension_installations`: adicionar `source_id`, `release_id`; migrar valores do catálogo. V2 permite `catalog_id` ausente apenas quando `source_id/release_id` coerentes; constraint explícita garante forma v1 ou v2. Manter unique antigo e acrescentar unique para identidade por fonte. Se duas linhas legadas conflitarem sob nova identidade, não deduplicar destruindo IDs; manter fonte/catálogo como fronteira até plano de reconciliação.
- `extension_artifacts`: bytes/document continuam sendo JSON de manifesto. ZIP fica fora em Storage. Limite v1 permanece 64 KiB; ampliar CHECK global para teto v2 é insuficiente: branch v1 do validador SQL continua exigindo 64 KiB. `sha256` legado sempre se refere aos bytes JSON; `package_sha256` é digest separado do ZIP.
- `organization_extensions`: ampliar configuração v2 sem enfraquecer CHECK de configuração v1; adicionar `configuration_schema_version`, `granted_permissions`, `consented_artifact_id`, `consented_by/at`; backfill respeita permissões existentes e perfil de dados; não inferir autorização nova.
- `extension_operations`: ampliar constraint de tipos/estados e relação escopo/org para novos tipos. O CHECK atual `(kind='configure') = (organization_id IS NOT NULL)` não permite import/autoria tenant; precisa migração deliberada. Campos novos: `scope_kind`, `target_organization_id` quando efeito de plataforma em tenant, `source_release_id/target_release_id`, `plan_id`, `fencing_token`, `initiator_token_id`, `backup_id`, `executor_job_id`. Reutilizar `request_fingerprint` e recibo durável; não alterar replay de operação antiga.

Ponteiros `previous_artifact_id` continuam funcionando como atalho para último passo; histórico completo vem da tabela seguinte. Uma única transação deve manter ponteiro, versão, release, revisão, histórico e recibo coerentes.

**C. Histórico, grants, consentimento e dados**

| Tabela                            | Escopo                               | Campos e invariantes                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension_installation_history`  | plataforma mediada                   | `id`, `installation_id`, `operation_id` unique, `from_artifact_id`, `to_artifact_id`, `from_version`, `to_version`, `schema_version_before/after`, `backup_id`, `actor_id`, `created_at`; append-only; não duplicar history por replay                                                          |
| `extension_change_plans`          | plataforma ou org explícito          | `id`, `scope_kind`, `organization_id` nullable apenas plataforma, `actor_id`, `digest`, `revision`, `expected_state`, `redacted_plan`, `status`, `expires_at`; tabelas mistas exigem duas políticas explícitas, ou separar tabelas na implementação para manter org NOT NULL no lado tenant     |
| `extension_publication_grants`    | acesso server-only, escopo explícito | `id`, `actor_id`, `token_id`, `scope_kind`, `organization_id` conforme escopo, `installation_id`/namespace permitido, `actions`, `expires_at`, `revoked_at`, `max_uses`, `uses`, `approved_at/by`, `revision`; consumo atômico; segredo do grant só hash                                        |
| `organization_extension_consents` | tenant                               | `organization_id`, `installation_id`, `artifact_id`, `permission`, `actor_id`, `accepted_at`, `revoked_at`, `revision`; identidade FK composta; histórico não apaga aceites antigos                                                                                                             |
| `extension_object_registry`       | plataforma mediada                   | `(installation_id, object_slug)` PK, `table_name` unique, `schema_version`, `schema_digest`, `privacy_contract`, `provisioned_at`; nomes compilados pelo host, limite PG 63 bytes                                                                                                               |
| `organization_extension_fields`   | tenant                               | `organization_id`, `installation_id`, `entity_type`, `field_slug`, `definition`, `revision`; FK/namespace; definições fonte para Zod, UI e filtros                                                                                                                                              |
| armazenamento de valores          | decidir DIRC por entidade            | leads aproveitam `custom_fields` existente; contatos usam campo existente somente se adequado, senão relação host-owned `organization_extension_field_values` com FK composta para a entidade real. Não criar EAV sem tipo/índice/ciclo LGPD; nenhuma tabela universal para dinheiro/transações |
| `extension_backup_receipts`       | plataforma/server-only               | `id`, `operation_id`, `scope`, `status`, `provider`, `artifact_inventory`, `schema_version`, `verified_at`, `restore_test_reference`, `failure_code`; sem dump nem segredo em DTO                                                                                                               |

Tabela de escopo misto é exceção, nunca “tenant_id opcional em todo lugar”. Se os gates da casa exigirem tabela tenant-aware uniforme, separar grants/plans de plataforma e tenant, mantendo domínio comum TS. O executor não deve afrouxar o invariante de RLS para satisfazer este rascunho de DDL.

**D. Loja, produtos, direitos e revenda — onda posterior**

Todas as tabelas deste grupo pertencem à organização vendedora (`organization_id NOT NULL`). Tenant comprador remoto é referência opaca no grant comercial, nunca FK para uma organização local supostamente homônima.

| Tabela                          | Campos mínimos e invariantes                                                                                                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension_stores`              | `id`, `organization_id`, `slug`, `display_name`, `public_status`, `issuer`, `support_policy`, `revision`; uma loja por organização no MVP proposto, ampliar só com demanda                                                                                                                          |
| `extension_offers`              | `id`, `organization_id`, `store_id`, `catalog_product_id`, `product_key`, `release_selector`, `price_cents`, `currency`, `use_model`, `updates_duration`, `updates_lifetime`, `terms_revision`, `distribution_rights_id`, `status`; decisão da fonte do preço pela projeção, pedido guarda snapshot |
| `extension_customers`           | `id`, `organization_id`, `contact_id` tenant-correct, `portal_subject` nullable, `external_buyer_ref`; conta de portal não cria membership                                                                                                                                                          |
| `extension_orders`              | `id`, `organization_id`, `store_id`, `customer_id`, `status`, `currency`, `total_cents`, `idempotency_key`, `created_by`, `created_via`, timestamps; unique org+key+fingerprint                                                                                                                     |
| `extension_order_items`         | `id`, `organization_id`, `order_id`, `offer_id`, `terms_snapshot`, `unit_price_cents`, `quantity`, `discount_cents`, `distribution_chain_snapshot`; FK composta, snapshot imutável                                                                                                                  |
| `extension_order_payments`      | `id`, `organization_id`, `order_id`, `method` (`manual`,`gateway`), `provider`, `merchant_connection_id`, `provider_payment_id`, `status`, `amount_cents`, `currency`, `confirmed_by/at`, `manual_reference`; unique merchant+provider event/ref quando existir                                     |
| `extension_licenses`            | `id`, `organization_id`, `order_item_id` nullable para concessão gratuita/manual, `product_key`, `buyer_id`, `status`, `use_expires_at`, `updates_expires_at`, `support_expires_at`, `activation_limit`, `terms_snapshot`, `revision`; emissão única por item/quantidade contratada                 |
| `extension_license_activations` | `id`, `organization_id`, `license_id`, `remote_instance_id`, `remote_org_ref`, `activated_at`, `revoked_at`, `last_checked_at`; limite contado sob lock; desativação libera slot conforme termos                                                                                                    |
| `extension_license_secrets`     | `organization_id`, `license_id`, `key_hash`, `last_four`, `rotated_at`; sem SELECT público e sem cópia do plaintext                                                                                                                                                                                 |
| `extension_resale_grants`       | `id`, `organization_id`, `product_key`, `parent_id`, `grantor_party_id`, `grantee_party_id`, `can_resell`, `can_subgrant`, `max_remaining_depth`, `valid_from/until`, `terms_snapshot`, `status`, `revision`; ciclo recusado; filho é subconjunto do pai                                            |
| `extension_sale_allocations`    | `id`, `organization_id`, `order_item_id`, `beneficiary_ref`, `rule_snapshot`, `basis_cents`, `amount_cents`, `currency`, `status` (`calculated`,`payable`,`settled`,`reversed`); unique item+beneficiário+regra; settlement manual separado                                                         |

Não implementar automaticamente 15 tabelas antes do primeiro caso comercial. Cada onda cria somente o subconjunto necessário; schema final aqui orienta fronteiras, não justifica overengineering. Orders/licensing podem começar com pedidos manuais e sem allocations/portal.

**E. Instalação compradora conectada**

`organization_extension_provider_connections`: `organization_id`, `id`, `source_id`, `issuer`, `remote_subject_ref`, `client_registration_ref`, `scopes`, `status`, `last_checked_at`, `revision`; unique org+issuer+subject se regra suportar. Secrets em tabela privada separada, tokens cifrados com rotação. `organization_extension_entitlements`: cache de claims assinados com `organization_id`, `license_ref`, `product_key`, `issuer`, `signed_document`, `validated_at`, `refresh_after`, `expires_at`, `error_code`; não inventa novas licenças quando cache falha.

Servidor vendedor guarda registro OAuth de cliente, grants/codes de uso único, refresh tokens em hash e revogação. Não armazenar chaves privadas assinantes em tabelas com leitura de tenant. Chaves públicas em JWKS com `kid`, validade e rotação; chaves aposentadas ficam verificáveis durante validade dos documentos existentes.

### 4.3 Exemplo de DDL de relação tenant

```sql
-- PROPOSTO: esqueleto; transformar em migration nova + apêndice idêntico.
create table if not exists public.organization_extension_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  overrides jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(overrides) = 'object')
);
alter table public.organization_extension_policies enable row level security;
revoke all on public.organization_extension_policies from public, anon, authenticated;
-- SELECT e escrita seguem helpers de membership/papel REAIS do checkout.
-- Usar política canônica tenant_isolation_* e RPC server-only para mutação/CAS.
-- Não conceder UPDATE bruto a authenticated para burlar teto global.
```

JSONB `overrides` exige validação fechada no serviço e RPC; o CHECK de objeto acima sozinho é insuficiente. Nenhuma policy compara org fornecida no body como se fosse prova de membership. FKs entre entidades tenant usam `(organization_id,id)`; RLS não impede FK cruzada por si só.

## 5. Contratos RPC e transações

Não mudar assinatura de RPC existente sem adapter e testes de compatibilidade. A onda inicial pode criar funções v2 internas e fazer wrappers v1 usarem o mesmo executor, preservando comportamento e códigos existentes. Funções SECURITY DEFINER têm `search_path` fixo, schema-qualified references, validação de ator atual, membership e escopo dentro da transação, revogação explícita de EXECUTE para `PUBLIC`, `anon` e `authenticated` quando não necessários. A service key não substitui prova do ator.

| Função proposta                                                                                              | Transação e efeito                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `fn_extensions_set_policy(actor, target_org, expected_revision, policy, operation)`                          | confere papel/teto e CAS, grava policy e recibo                                                                 |
| `fn_extensions_register_release(actor, source, artifact, inventory, operation)`                              | imutabilidade por identidade/versão; conteúdo diferente recusa; não ativa                                       |
| `fn_extensions_prepare_plan(actor, plan, operation)`                                                         | confere acesso, revisões, lock de instalação/core; persiste plano/fingerprint                                   |
| `fn_extensions_commit_plan(actor, plan_id, expected_digest, fencing_token)`                                  | revalida grant, policy, consentimentos, dados/schema, dependencies; troca ponteiros/history/recibo em um commit |
| `fn_extensions_configure_v2(actor, org, installation, expected_revision, consent, configuration, operation)` | contrato exato e consentimento pela org; esquema v1 continua ramo próprio                                       |
| `fn_extensions_issue_publication_grant(actor, scope, target, actions, expires_at, max_uses, operation)`      | somente pessoa autenticada autorizada no CRM; token MCP não se autoautoriza                                     |
| `fn_extensions_consume_publication_grant(actor, token, grant, plan_digest)`                                  | usa lock/CAS para impedir consumo simultâneo duplicado                                                          |
| `fn_extensions_issue_license(actor, order_item, entitlements, operation)`                                    | papel comercial, pagamento manual confirmado ou estado relido; idempotência por item                            |
| `fn_extensions_activate_license(principal, license, remote_instance, remote_org, operation)`                 | prova comercial, limite de ativações sob lock, registro e documento assinado após commit                        |
| `fn_extensions_grant_resale(actor, parent, recipient, terms, operation)`                                     | autor/titular ou delegação suficiente, anti-ciclo, subconjunto e snapshot                                       |

Não confiar em `actor_id` exposto pelo PostgREST: endpoints validam sessão/token e funções não têm EXECUTE público. Assinatura de entitlements é feita fora do SQL após gravar registro canônico; se resposta de assinatura se perder, pode regenerar documento consistente do mesmo registro sem emitir licença nova.

Locks ordenados por fonte/pacote/instalação para evitar deadlock, escopo de transação curto, sem HTTP. Alterações concorrentes em duas dependências precisam travas na mesma ordem. Timeouts retornam estado desconhecido com ID do recibo. Jobs usam claim com lease/fencing e fila existente, não outra ferramenta de workflow.

## 6. API REST proposta e compatibilidade

Rotas atuais sob `/api/v1/extensions` continuam. Novos endpoints usam wrappers `ok/fail`, schemas estritos, `Idempotency-Key` nas escritas e precondições por revisão. O `/v1` no path é a versão da API HTTP, independente de `format_version` do pacote. Binary upload é seguido de metadado; preferir upload tokenizado temporário quando suportado, sempre com finalização server-side verificada.

| Endpoint proposto                                              | Auth e resultado                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/extensions/marketplace`                           | catálogo filtrado pela organização, direitos e política; não expõe segredos                                       |
| `GET /api/v1/extensions/releases/:id`                          | metadados seguros e compatibilidade; privadas exigem org autorizada                                               |
| `POST /api/v1/extensions/imports`                              | admin tenant se política ou plataforma; aceita referência de upload ou URL da fonte, retorna recibo de quarentena |
| `POST /api/v1/extensions/sources`                              | admin propõe/adiciona fonte da própria org sob teto; revisão de plataforma separada                               |
| `GET/PUT /api/v1/extensions/policy`                            | admin própria org; revisão obrigatória; não muda global                                                           |
| `POST /api/v1/extensions/plans`                                | instalar/atualizar/remover/reverter; retorna plano e impacto sem efeito                                           |
| `POST /api/v1/extensions/plans/:id/apply`                      | contexto/revisão/digest e confirmação exigida; grant MCP se publicação                                            |
| `GET /api/v1/extensions/:id/versions`                          | histórico permitido; não lista dados de outras orgs                                                               |
| `POST /api/v1/extensions/drafts`                               | criar rascunho do próprio pacote/editável                                                                         |
| `GET/PUT /api/v1/extensions/drafts/:id/files/:path`            | path normalizado, extensão permitida, direitos; CAS arquivo/workspace                                             |
| `POST /api/v1/extensions/drafts/:id/validate`                  | inventário, erros, compatibilidade, referência de candidato                                                       |
| `POST /api/v1/extensions/drafts/:id/export`                    | download autenticado se direito de fonte; URL não contém token permanente                                         |
| `POST /api/v1/extensions/publication-grants`                   | sessão web, papel real, confirmação recente aplicável; emite janela limitada                                      |
| `POST /api/v1/extensions/publication-grants/:id/revoke`        | dono ou plataforma dentro do escopo                                                                               |
| `GET/PUT /api/v1/admin/extensions/policy`                      | platform admin real; never token tenant                                                                           |
| `GET /api/v1/admin/extensions/tenants`                         | status/contagens, sem conteúdo de clientes                                                                        |
| `POST /api/v1/admin/tenants/:id/extensions/plans`              | alvo path validado, autorização suporte/write, audit cross-tenant                                                 |
| `GET /api/v1/extension-store/:store/catalog`                   | público só ofertas publicadas e DTO limpo; rate limit                                                             |
| `POST /api/v1/extension-store/:store/orders`                   | comprador autenticado/resgate autorizado; preço calculado no servidor                                             |
| `POST /api/v1/extension-store/:store/licenses/validate`        | principal remoto autorizado, credencial em header, claims mínimos                                                 |
| `GET /api/v1/extension-store/:store/updates`                   | licença/issuer/product checks, metadados assinados                                                                |
| `GET /api/v1/extension-store/:store/releases/:release/package` | autorização comercial e versão permitida; transferência autenticada                                               |
| `POST /api/v1/extension-commerce/orders/:id/manual-payment`    | vendedor autorizado; justificativa e idempotência; invisível ao agente de vendas                                  |
| `POST /api/v1/extension-commerce/orders/:id/checkout`          | oferece gateway conectado da loja; método suportado explícito                                                     |

As rotas públicas de loja não são rotas administrativas sem cookie. `public-paths.ts` permite chegar ao guard correto, não dispensa autorização. Cookie SameSite=Strict exige testar redirecionamento OAuth real; callback usa estado/código de uso único e restaura jornada autenticada de forma compatível, sem enfraquecer cookie global para “resolver”.

Falhas novas propostas: `extension_source_not_allowed`, `extension_source_unverified`, `extension_release_conflict`, `extension_zip_unsafe`, `extension_dependency_cycle`, `extension_dependency_conflict`, `extension_base_inactive`, `extension_plan_stale`, `extension_permission_consent_required`, `extension_shared_update_requires_platform`, `extension_source_read_forbidden`, `extension_grant_expired`, `extension_grant_revoked`, `extension_backup_required`, `extension_data_rollback_incompatible`, `extension_result_unknown`, `extension_license_unavailable`, `extension_license_invalid`, `extension_updates_expired`, `extension_resale_not_allowed`. Mapear para 400/401/403/409/410/413/422/429/502/503 conforme semântica, com testes de códigos TS/SQL/HTTP e mensagens traduzidas. Indisponível e inválida são estados diferentes.

## 7. MCP e CLI

### 7.1 Ferramentas propostas

| Tool                                                                                                 | Scope mínimo proposto                          | Limite                                                          |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `crm_list_extensions`, `crm_get_extension`                                                           | `extensions:read`                              | organização do token, metadata limpa                            |
| `crm_list_extension_versions`, `crm_get_extension_operation`                                         | `extensions:read`                              | histórico/recibo autorizado                                     |
| `crm_plan_extension_change`                                                                          | `extensions:manage`                            | admin + política; apenas simulação                              |
| `crm_apply_extension_plan`                                                                           | `extensions:manage` + publicação se necessária | digest/revisão, grant e confirmação real                        |
| `crm_configure_extension`, `crm_set_extension_enabled`                                               | `extensions:manage`                            | só vínculo próprio, consentimento/role                          |
| `crm_create_extension_draft`, `crm_write_extension_file`                                             | `extensions:develop`                           | admin + pacote editável + workspace próprio                     |
| `crm_list_extension_files`, `crm_read_extension_file`                                                | `extensions:source`                            | inventário completo permitido; nega pacote fechado              |
| `crm_validate_extension_draft`, `crm_export_extension_draft`                                         | `extensions:develop` / `extensions:export`     | sem código/shell arbitrário                                     |
| `crm_publish_extension_draft`                                                                        | `extensions:publish`                           | grant temporário de servidor obrigatório                        |
| `platform_list_extension_tenants`, `platform_plan_extension_change`, `platform_apply_extension_plan` | principal de plataforma + scopes próprios      | target explícito/seleção congelada; não elevação de dsk_ tenant |
| `crm_search_extension_offers`, `crm_create_extension_checkout`, `crm_get_extension_purchase`         | comercial apropriado                           | agente comercial pode consultar/cotar; não administra extensões |

Scopes são propostos; atualizar catálogo de API tokens, UI de emissão, validador/DB e contrato MCP de forma consistente. A arquitetura de bearer atual é tenant-scoped: **não basta acrescentar `tenant_id` opcional em tool para fazer MCP da rede**. Criar um tipo de credencial administrativa de plataforma separado ou um grant que vincule usuário platform admin autenticado a sessão MCP privilegiada; sua emissão/revogação tem UI própria e testes. Antes disso, tools globais ficam indisponíveis e não simulam suporte.

Catálogo registra `apenasHumano` quando aplicável, papel admin e política de elegibilidade; a flag sozinha é apresentação, não segurança. Um assistente externo com delegação administrativa é distinto do agente comercial do CRM. O agente público não ganha ferramentas de instalar/editar por instrução de prompt, compra de plugin ou contato autenticado no portal.

### 7.2 Publicação temporária e confirmação

A interface mostra pacote, alvo, ações, duração escolhida e limite de operações. PROPOSTO para defaults revisáveis: janela de 1 hora, máximo local de 24 horas, revogável, escopo por pacote/namespace e token. Esses números são parâmetros iniciais propostos, não decisões anteriores nem SLA. Autorização de rede precisa texto e principal próprios. Grant não contém segredo do banco.

O agente primeiro envia candidato e recebe plano. Pessoa confirma no CRM ou em UI de aprovação autenticada que grava nonce/digest do plano no servidor. `confirmed: true` enviado pelo próprio modelo não confirma nada. Evitar três perguntas idênticas sem ganho: uma confirmação rica e vinculada a bytes/alvo protege mais que repetição textual. Se o usuário optar por janela de autonomia, a UI declara quais efeitos pode autorizar antecipadamente; alteração de namespace, escopo, permissões ou schema destrutivo excede a janela.

### 7.3 CLI

`deskcomm extensions list|inspect|import|plan|apply|versions|rollback|configure|draft|validate|export`. Implementar inicialmente como script TypeScript sobre a API documentada, sem dependência de Git e sem acesso direto a Postgres. Config em arquivo privado do perfil com permissão restrita e credencial em mecanismo seguro; nunca imprimir tokens. `--json` estável para integrações; `--dry-run` retorna mesmo plano do MCP/UI. Operações de plataforma usam perfil separado. Nenhuma CLI existente é presumida.

## 8. Dados e pontos de extensão seguros

Registro de slot do host proposto: `contact.details.sections`, `lead.details.sections`, `conversation.context.cards`, `contact.actions`, `lead.actions`. Cada slot tem schema de input/output e identidade estável; posição é preferência em lista com desempate por identidade, não seletor CSS de DOM interno. Contribuições recebem dados mínimos autorizados, não objeto global de app.

Campos: `key = installation_id + entity + field_slug`, tipo fechado, required, enum/options, valor/default server-side, readonly, privacidade, validação e index policy. Esquema de UI é derivado; máscara/formatação nunca modifica valor bruto inadvertidamente. Dinheiro usa centavos + moeda; data civil não vira timestamp em timezone do navegador; arquivo guarda referência privada e não URL arbitrária do manifesto.

Ações: descritor nomeado, input/output Zod, permissão, papel mínimo, tipo de efeito, idempotência e regra de confirmação. Handler do host chama regra existente de tarefas/propostas/agenda, preservando audit e guardrails. Filters do estilo WordPress só em valores contratuais, determinísticos e com ownership claro; não callbacks arbitrários injetados em funções privilegiadas.

Objetos v2: registrar tabela por installation_id e object_slug; nome curto gerado pelo host e único dentro de 63 bytes. O nome legado baseado em publicador/módulo/objeto fica preservado para objetos v1 existentes. Testar colisão de nomes truncados e mesmo slug vindo de fontes diferentes; não usar `.limit(1)` por nome como resolução final. Foreign keys tenant compostas, schema plan allowlisted, sem SQL de terceiro. Antes de referenciar objeto de outra extensão, dependency/grant estável e contrato de schema; ausente/disabled retorna erro de dependência, não tabela inválida.

## 9. Integrações conectadas, eventos e OAuth

Para `connected`, origem do serviço e endpoints residem no catálogo revisado. Host emite token estreito de módulo por instalação+org conforme ADR-0005; iframe separado com CSP/sandbox, postMessage com origem e schema, sem passar bearer duradouro em URL. Dados retornados são não confiáveis: XSS sanitizado, tamanhos limitados, conteúdo não substitui system prompt. Rede configurada por secrets fica só no servidor.

Entrega de evento tem `event_id`, `type`, `schema_version`, `occurred_at`, `organization_ref`, `installation_id`, `payload` mínimo e assinatura/HMAC conforme contrato. Ledger de delivery com estado `pending/running/delivered/failed/dead`, tentativas/backoff, claim e DLQ; at-least-once requer consumidor idempotente. Revogar token impede novas chamadas na mesma fronteira transacional; retries não ressuscitam grant revogado. Nenhum trigger SQL faz HTTP.

A conexão de compra entre CRMs é outro principal que o módulo runtime. OAuth scopes de loja não equivalem a ferramentas `module_action`. Descoberta tem issuer exato, registro de client/callback autorizado e SSRF. Usar código de autorização + PKCE S256, state, expiração e code de uso único, tokens refresh rotativos e revogação. Device Flow opcional não confia só no código exibido sem identificar destino. Testar conta distinta nos dois lados, login expirar no meio, callback duplicado, rotação de signing keys e loja migrando domínio por procedimento explícito.

## 10. Estado, auditoria e operação

Transições propostas de novo plano: `draft -> validated -> awaiting_approval -> approved -> preparing -> ready_to_commit -> completed`; saídas `cancelled`, `failed`, `unknown`. Não substituir estados wire v1 de recibo por esses valores: armazenar estágio de plano/job separado ou ampliar com leitor compatível. Toda transição tem autor/contexto e idempotência. `unknown` exige consulta/reconciliação, não retry cego.

Eventos novos propostos: `extension.release_submitted`, `extension.release_reviewed`, `extension.plan_applied`, `extension.license_changed`, `extension.update_available`, `extension.update_failed`, `extension.sale_paid`, `extension.resale_granted`. Emissão de evento transacional com efeito/outbox; audit API continua sua política fire-and-forget com alerta se falhar, recibo é evidência durável canônica. Não alegar audit complementar sempre atômico se mecanismo existente não é.

Tela mostra recibo e operações pendentes; Central abre aviso deduplicado por operação/fonte, atribui responsável e fecha aviso ao reconciliar. Logs têm correlation id, código seguro, fase, versão e tempo; sem arquivo completo, segredo, endereço com token ou PII. Configuração de licença/conexão mostra estado, última validação, reautorizar, desconectar e prazo de atualização. Métricas úteis: sucesso de instalação, falhas por fase, tempo de recuperação, entregas pendentes, licenças aguardando confirmação; contramétrica: reativações indevidas, bloqueios falsos por offline e efeitos duplicados.

## 11. Pontos técnicos que precisam de decisão explícita na Onda 0

1. Política inicial de licença de código v2, respeitando MIT legado e direitos de terceiros; revisão comercial/jurídica fora de suposição do implementador.
2. Fonte autoritativa de identidade/publicador e modelo de assinatura/metadados; preferir biblioteca/protocolo mantido a criptografia caseira.
3. Modelo de credencial administrativa MCP de plataforma, sem elevar token tenant.
4. Forma de tabelas plans/grants de escopo misto versus separadas, obedecendo gates RLS.
5. Granularidade de backup e quais alterações podem ser revertidas online em banco compartilhado.
6. Conjunto inicial de slots/campos e limite medido de pacote. Números novos são propostas a medir.
7. Regras de rede para fontes internas de uma instalação self-host: padrão público HTTPS; exceção de laboratório explicitamente isolada, nunca bypass de produção.
8. Política de licença ao reembolso/revogação, suporte e uso após expiração conforme oferta; não inventar uma decisão global contrária ao pedido.

O plano de execução aponta qual onda cada decisão bloqueia. As ondas independentes podem avançar com contratos já fechados; não bloquear documentação, pesquisa ou parser legado por um futuro marketplace financeiro.

## 12. Contratos completos de uma primeira fatia implementável

Esta seção evita que o executor tenha que inventar o comportamento da primeira extensão. É **PROPOSTA**, com nomes de capacidades a reservar formalmente na O0. O exemplo só passa a ser válido depois de o host implementar o schema correspondente; não deve ser enviado ao parser v1 atual.

### 12.1 Capacidades/permissões iniciais a implementar com consumidor

| Permissão proposta       | O que concede                            | Quem decide em runtime           | O que não concede                             |
| ------------------------ | ---------------------------------------- | -------------------------------- | --------------------------------------------- |
| `fields.contacts.define` | registrar definição de campo de contato  | instalação + consentimento org   | ler todos contatos ou editar perfil nativo    |
| `fields.leads.define`    | registrar definição namespaced de lead   | schema de pipeline + org         | mudar etapas/posições do funil                |
| `data.own.read`          | consultar registros próprios da extensão | papel do usuário + org + relação | dados próprios de outras extensões/empresas   |
| `data.own.write`         | criar/alterar registro declarado         | host CRUD + role + validação     | SQL/cliente Supabase/schema arbitrário        |
| `ui.contact.section`     | contribuir seção da ficha                | slot host + filtros de dados     | DOM, cookies ou CSS global                    |
| `actions.tasks.create`   | oferecer ação de tarefa via host         | regras de tarefa e ator atual    | envio de mensagem, handoff ou concessão admin |

Definir separadamente leitura/escrita de campos onde a primeira ação realmente precisar. O consentimento de definir campo não significa que todo usuário possa ler seu valor. O pacote pode pedir capacidades adicionais no futuro apenas em nova publicação/fluxo de concessão explícito. A primeira implementação recusa alteração do conjunto de permissões numa atualização normal; não contornar publicando mesmo pacote com slug escondido ou atribuindo concessão genérica.

### 12.2 Exemplo de manifesto v2 da base

```json
{
  "format_version": 2,
  "profile": "data",
  "publisher": "servinder-exemplos",
  "name": "qualificacao-uniformes",
  "version": "1.0.0",
  "code_license": { "spdx": "MIT" },
  "host_api": { "min": 3, "max": 3 },
  "schema": { "version": 1, "readable_min": 1, "readable_max": 1 },
  "permissions": [
    "fields.contacts.define",
    "fields.leads.define",
    "data.own.read",
    "data.own.write",
    "ui.contact.section",
    "actions.tasks.create"
  ],
  "dependencies": [],
  "display": {
    "title": { "pt-BR": "Qualificação de uniformes" },
    "summary": { "pt-BR": "Organize quantidade e prazo desejado na ficha do cliente." },
    "category": "sales",
    "icon": "ListChecks"
  },
  "configuration": {
    "schema_version": 1,
    "fields": [{ "key": "create_task_enabled", "type": "boolean", "default": true }]
  },
  "data": {
    "mode": "declarado",
    "objects": [
      {
        "slug": "briefing",
        "label": { "pt-BR": "Briefing" },
        "fields": [
          { "slug": "quantidade", "type": "integer", "required": true, "min": 1 },
          { "slug": "prazo-desejado", "type": "date", "required": false }
        ],
        "references": [{ "slug": "contato", "entity": "contact", "required": true }],
        "privacy": { "personal_fields": [], "sensitive_fields": [], "contact_reference": "contato" }
      }
    ]
  },
  "contributions": {
    "fields": [{ "entity": "lead", "slug": "quantidade", "type": "integer", "min": 1 }],
    "sections": [{ "slot": "contact.details.sections", "id": "briefing", "object": "briefing" }],
    "actions": [
      {
        "slot": "contact.actions",
        "id": "abrir-tarefa",
        "capability": "tasks.create",
        "label": { "pt-BR": "Preparar orçamento" }
      }
    ],
    "exports": [{ "name": "briefing.read", "version": "1.0.0" }]
  }
}
```

`host_api=3` é número proposto para nova família, não uma versão atual do host. A O0 deve reservar o próximo contrato realmente livre e atualizar exemplo/decoder/banco juntos. Nomes inglês no novo perfil não autorizam misturar silenciosamente o vocabulário português do perfil `data` v1; o decoder v2 adapta ao modelo interno normalizado. Se preferirem manter o vocabulário v1, revisar o exemplo e JSON Schema antes de implementar, sem suportar dois aliases ambiguamente.

Complemento de comissão declara fonte fixa de exemplo, base `qualificacao-uniformes`, range `>=1.0.0 <2.0.0` e contrato `briefing.read >=1.0.0 <2.0.0`. Não precisa declarar acesso a todo contato para receber o resultado mínimo autorizado. Não colocar fórmula em expressão JS string; cálculo usa operação determinística registrada pelo host ou serviço conectado explicitamente habilitado em onda própria.

### 12.3 Defaults de política propostos, não herdados do v1

```json
{
  "policy_version": 1,
  "tenant_catalog_install": true,
  "tenant_zip_import": false,
  "tenant_custom_source": false,
  "tenant_development": false,
  "tenant_source_export": false,
  "mcp_publication": false,
  "auto_update": false,
  "store_enabled": false,
  "allow_network_availability": true
}
```

Estes defaults só valem para capacidades novas e são **propostos**: não desligam o gerenciamento v1 já disponível. `tenant_catalog_install=true` significa permitir uso de release já aprovada e disponibilizada, com papel/grants; não promover tenant a administrador global. `allow_network_availability` permite listar pacote, não força ativação. Uma política tenant guarda apenas overrides permitidos, revision e ator. A UI de plataforma oferece “usar default para empresas atuais e futuras” e “exceção desta empresa”; abandonar exceção retorna à herança sem apagar histórico.

### 12.4 Resumo comercial devolvido à instalação compradora

```json
{
  "protocol_version": 1,
  "issuer": "https://loja.exemplo.invalid",
  "audience": "instance:exemplo-comprador",
  "product_key": "servinder-exemplos/qualificacao-uniformes",
  "license_ref": "opaque-license-ref",
  "organization_ref": "opaque-buyer-company-ref",
  "status": "active",
  "rights": {
    "use_expires_at": null,
    "updates_expires_at": "2027-10-26T18:00:00Z",
    "support_expires_at": "2027-10-26T18:00:00Z",
    "source_read": false,
    "source_edit": false,
    "resale": false
  },
  "issued_at": "2026-10-26T18:00:00Z",
  "refresh_after": "2026-10-27T18:00:00Z",
  "expires_at": "2026-11-02T18:00:00Z"
}
```

Exemplo sintético de claims, a assinar com biblioteca/protocolo escolhido; datas são ilustração, não política fixa de refresh/grace. Token OAuth que busca este documento é segredo separado. `status=active` com signature inválida não vale. `updates_expires_at` da licença filtra releases por data autoritativa assinada de publicação; relógio do cliente e `uploaded_at` de revendedor não permitem estender janela. Se direitos de update comprados permitirem baixar todas releases publicadas no período mesmo após expiração, documentar e testar esse critério na oferta; não confundir download tardio de release antiga com acesso a release nova.

### 12.5 Exemplo de plano apresentado ao humano

```json
{
  "operation": "update",
  "installation_id": "uuid-of-installed-package",
  "from_version": "1.0.0",
  "to_version": "1.1.0",
  "affected_organizations_count": 2,
  "new_permissions": [],
  "dependencies_changed": [],
  "data_impact": "add_optional_field",
  "rollback": { "package_compatible": true, "restores_database": false },
  "backup": { "requirement": "scoped_snapshot", "status": "pending" },
  "confirmation": { "required": true, "plan_id": "uuid", "digest": "sha256-of-canonical-plan" }
}
```

Payload é resumo, não um plano aceito literalmente como verdade do cliente. O servidor gera UUIDs, digest, lista de organizações e análise de schema. O modelo não pode declarar `new_permissions: []` para esconder mudança. Arquivo/versão/policy diferente invalida o digest. O apply só conclui quando evidência de backup exigido estiver verificada. Após commit, worker emite evento de invalidação para todas orgs afetadas sem vazar seus IDs ao admin tenant.

## 13. Invariantes de negócio para codificar, sem exceções por superfície

1. Nenhum pacote novo altera seu manifesto/release publicado no lugar; sempre outra versão.
2. Nenhum caminho de UI/REST/MCP/CLI troca ponteiro sem revisão/fingerprint da mesma operação.
3. Instalação técnica, consentimento, direito comercial e papel são quatro condições independentes.
4. Nenhum import de tenant afeta release usada por outra empresa sem decisão de plataforma.
5. Nenhum admin comercial marca pagamento confirmado pelo simples retorno de checkout do comprador.
6. Nenhum token de loja/OAuth dá acesso aos contatos/conversas do comprador por implicação.
7. Nenhum pacote fechado tem download de desenvolvimento por conhecer artifact_id ou digest.
8. Autor/titular pode permitir revenda; um grant descendente nunca aumenta poderes do pai.
9. Comissão calculada não é repasse concluído nem dinheiro em custódia da plataforma.
10. Banco compartilhado não é restaurado automaticamente para satisfazer rollback de uma empresa.
11. Mesmo hash/assinatura/revisão não prova software remoto intacto; selo sempre descreve o que mediu.
12. Features opcionais desligadas não fazem rede para catálogo/licença, não bloqueiam login e não mudam operação comum.
