# Frente independente — Mercado Pago na cobrança do DeskcommCRM

Data: 26/10/2026. **PROPOSTA TÉCNICA, NÃO IMPLEMENTADA.** Relacionada ao [programa de Extensões](2026-10-26-extensoes-plataforma-design.md), mas executável em frente própria. O pedido é adicionar Mercado Pago ao domínio de cobrança já existente, com configuração clara e recursos de teste. Loja/licenciamento não dependem desta frente para vender manualmente.

## 1. O que existe e o que precisa ser provado

A base WSL inspecionada contém `lib/cobranca/provedores/{contrato,index,stripe,asaas,base-de-teste}.ts`, vocabulário/configuração, checkout, estado, reconciliação e webhooks. O contrato `AdaptadorDeCobranca` é orientado a assinatura SaaS, não a todo pagamento avulso ou split. Não há adapter Mercado Pago na base. A ADR-0004 deixou Mercado Pago fora da primeira entrega; adicioná-lo é evolução planejada, não bug de configuração.

“Adaptador completo” significa mapear cada método/semântica da interface, provar os recursos suportados e bloquear recursos indisponíveis com mensagem honesta. Não devolver sucesso fictício para cumprir TypeScript. Nenhuma assinatura existente muda de provedor automaticamente; as antigas continuam vinculadas à conexão/conta/modo onde nasceram.

## 2. Credenciais e UX: corrigir a hipótese de quatro campos fixos

A documentação atual distingue Public Key, Access Token, Client ID e Client Secret; a combinação usada depende do produto integrado e do modo. Portanto não modelar “Client ID e Secret de teste e produção” como se esses quatro campos fossem suficientes para todo fluxo. O backend precisa da credencial apropriada do produto; OAuth e frontend têm necessidades distintas. O formulário deve ter seções Teste e Produção, mostrando apenas campos necessários ao fluxo escolhido e permitindo guardar configurações separadas. A validação de ambiente não pode depender só do prefixo textual do token. [Credenciais oficiais](https://www.mercadopago.com.br/developers/en/docs/your-integrations/credentials), consultado em 26/10/2026.

Esquema PROPOSTO de configuração segura:

```ts
type MercadoPagoConnection = {
  mode: "teste" | "producao";
  merchantId: string | null;
  applicationId: string | null;
  credentialRevision: number;
  verification: { status: "pending" | "verified" | "failed"; checkedAt: string | null };
  publicKey?: string; // frontend apenas se produto precisar
  accessTokenSecretRef: string; // backend/cofre
  oauthClientId?: string;
  oauthClientSecretRef?: string;
  webhookSecretRef?: string;
};
```

Esse tipo é configuração proposta, não justificativa para duplicar o cofre existente. Usar padrão de cifra/config de cobrança atual, acesso só pelo dono autorizado, gravação/redação seguras e DTO mascarado. O superadmin configura cobrança global das empresas; uma futura loja tenant precisa de conexão de merchant da organização vendedora separada. Nunca cobrar clientes da loja na conta global de assinatura por fallback.

UX de teste: selecionar modo → configurar/conectar → validar acesso/conta → conferir capacidades → criar transação/assinatura sintética de teste autorizada → acompanhar retorno e webhook → reconciliar status → limpar quando suportado → relatório com “medido/não medido”. Mostrar passo a passo, origem do dado, última conferência e próximo passo. Botão “testar” não pode criar cobrança real.

## 3. Contas e cartões de teste

A referência oficial oferece criação de usuário de teste em `/users/test`. Os dados e cartões usados nos testes dependem do produto e do país; a interface pode ajudar a criar conta sintética, mostrar dados de teste autorizados e links de documentação, mas não prometer enumerar todas as contas existentes ou recuperar senhas que a API não devolve. Não usar dados de clientes reais como fixture. [API de usuário de teste](https://www.mercadopago.com.br/developers/en/reference/test_user/_users_test/post) e [teste de compra de assinatura](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/integration-test/payment-approval).

A documentação também lista ferramentas oficiais MCP para operações de desenvolvimento. Avaliar a integração oficial como auxílio ao administrador quando aplicável; isso não significa expor tokens ou credenciais no chat do agente comercial. Sua existência não prova que todo endpoint REST de cobrança oferece a mesma operação. [Ferramentas oficiais Mercado Pago MCP](https://www.mercadopago.com.br/developers/pt/docs/mcp-server/tools).

Dados de cartões devem vir da documentação oficial do produto escolhido e ser identificados como sintéticos; não copiar uma tabela de outro checkout e afirmar que funciona em assinatura. Se uma operação de listar/criar/consultar não existir ou não for permitida, apresentar instrução para fazer no painel do provedor e continuar o wizard. Evitar armazenar senha de conta de teste desnecessariamente; se precisar retê-la por uma sessão, aplicar o mesmo padrão de segredo e expiração.

## 4. Mapeamento a comprovar método por método

A API de assinaturas expõe criação em `/preapproval`; o guia descreve consulta, alterações e cancelamento. Estes são pontos de partida para ensaio, não prova de equivalência com a política atual de Stripe/Asaas. [Criar assinatura](https://www.mercadopago.com.br/developers/pt/reference/online-payments/subscriptions/create-preapproval/post) e [gerenciamento](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/subscription-management).

| Método atual                | Investigação/implementação exigida                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testarChave`               | credencial válida, identidade merchant, produto/modo aplicáveis; não enviar produção a teste “só para conferir”                                    |
| `prepararWebhook`           | assinatura e configuração por aplicação/produto; se manual, fornecer URL/segredo/eventos sem fingir criar via API                                  |
| `removerWebhooks`           | só endpoints da instalação/conexão; se API não suporta, declarar ação manual e não remover outros                                                  |
| `clienteExiste`             | cliente/ref pertence à mesma conta e modo; 404 real diferente de auth/timeout                                                                      |
| `garantirCliente`           | mapear conceito de pagador/customer de assinaturas, identificador estável e idempotência; não criar customer fictício só para satisfazer interface |
| `iniciarAssinatura`         | checkout hospedado de assinatura, trial e referência segura de organização; status autorizado não é pagamento confirmado                           |
| `iniciarAjusteProporcional` | cobrança complementar com referência/idempotência e conta/modo corretos; se sem equivalência, bloquear upgrade proporcional até solução formal     |
| `lerPagamentoProporcional`  | traduzir status reais, não marcar pending/authorized como pago                                                                                     |
| `lerSituacao`               | principal, assinaturas vivas, primeiro pagamento, atraso, período pago, valor e moeda; consultar recursos suficientes, não só preapproval.status   |
| `trocarPlano`               | preço futuro e data de renovação; provar que semântica de upgrade não cobra o mesmo período duas vezes                                             |
| `expirarSessao`             | identificar recurso expirável; se não há cancelamento equivalente, impedir link velho cobrando preço antigo, não no-op silencioso                  |
| `cancelarNoFim`             | verificar suporte nativo ou implementação local de agendamento + reconciliação; preservar direito pago e impedir nova cobrança após término        |
| `urlDeGerenciar`            | retornar portal real permitido ou null com explicação; não inventar URL                                                                            |
| `verificarWebhook`          | implementar assinatura conforme produto e bytes/headers reais; sem misturar dialeto de QR/outro checkout                                           |

A documentação do provedor evolui por produto. Antes de fechar o desenho técnico, criar tabela “nativo / mediado pelo host / não suportado”, com evidência de sandbox e impacto no contrato. Se algum método não couber, propor evolução tipada de capabilities para **todos** adaptadores, sem `if mercado_pago` em features e sem apagar regras da cobrança atual.

## 5. Webhook e segurança

Usar raw request, headers e formato de assinatura exatamente do produto escolhido, com comparação em tempo constante e limitação de replay/tamanho/tempo conforme contrato oficial. O sinal só inicia releitura autenticada na API; não confiar em status/amount do corpo. Conferir merchant, moeda, ambiente, referência de assinatura/pedido e valor ao reconciliar. [Webhooks oficiais](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/additional-content/your-integrations/notifications/webhooks).

Não guardar PAN/CVV/cartão real no DeskcommCRM. Preferir checkout hospedado. Token, secret, dados de teste sensíveis e corpo bruto de provedor não entram em audit/Sentry/erro de UI. Wrapper `ErroDoProvedor` preserva status/código seguro/transitoriedade sem vazamento. Fail-closed para assinatura/credencial ausente; indisponibilidade não cancela assinatura válida nem zera direitos do tenant.

## 6. Arquivos de implementação previstos

- Novo `lib/cobranca/provedores/mercado-pago.ts` e `mercado-pago.test.ts`, injeção de fetch, relógio e resolução de segredo como adapters irmãos.
- `lib/cobranca/provedores/contrato.ts`: só ampliar capabilities quando indispensável e provar Stripe/Asaas no mesmo contrato.
- `lib/cobranca/provedores/index.ts`, `vocabulario.ts`, `configuracao.ts`, `falhas.ts`: registro, códigos, estados e credenciais por modo.
- `app/api/v1/admin/cobranca/conexao/route.ts`, server action de configuração e `app/admin/(protected)/cobranca/`: formulário/dados mascarados/testes por etapas.
- `app/api/v1/webhooks/cobranca/[provedor]/route.ts`: dialeto MP validado e allowlist explícita; rota desconhecida continua 404.
- `lib/cobranca/{checkout,sincronizar,estado,troca,rodada}.ts`: consumir contrato comum sem provider leaking.
- `tests/e2e/fixtures/provedor-de-cobranca.ts` e fixtures do dialeto novo conforme padrão real, contrato do dublê, novos E2E de wizard/assinatura; smoke real opt-in `scripts/smoke-mercado-pago.ts`.
- Migration futura para CHECK do provedor, conexão/credenciais/modo e referências necessárias + baseline idêntico + tipos. Corrigir constraints antigas com backfill seguro, sem mudar assinaturas existentes.
- Mapa `docs/architecture/cobranca-do-revendedor.architecture.json`, spec cobrança, guia `docs/saas/cobranca.md`, fragmento de release e i18n. Não criar checkout de extensão neste mesmo lote.

## 7. Casos mínimos MP de aceitação

| ID   | Caso                                                  | Resultado esperado                                                         |
| ---- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| MP01 | modo teste e credencial aplicável válidos             | identidade/modo verificados, sem operação real                             |
| MP02 | modo ou conta divergentes                             | recusa antes de criar cobrança                                             |
| MP03 | 401/403/404/429/5xx/timeout/JSON inválido             | códigos e transitoriedade coerentes, sem segredo                           |
| MP04 | Public Key somente no cliente quando necessária       | Access Token/secret nunca no browser                                       |
| MP05 | conexão global vs merchant tenant                     | sem fallback entre contas                                                  |
| MP06 | criar usuário de teste suportado                      | dado sintético, autorizado e não logado                                    |
| MP07 | listar/recuperar conta não suportado                  | instrução de painel, sem falso sucesso                                     |
| MP08 | testar wizard                                         | mostra passos medidos e pendentes, teclado/celular/idioma                  |
| MP09 | configurar webhook manual quando necessário           | UI registra estado real, não “conectado” sem prova                         |
| MP10 | assinatura válida do produto correto                  | aceita sinal, relê estado canônico                                         |
| MP11 | assinatura ausente/forjada/alterada/antiga            | recusa; zero alteração comercial                                           |
| MP12 | webhook duplicado/fora de ordem                       | não duplica confirmação/reativação                                         |
| MP13 | assinatura autorizada sem primeiro pagamento          | não libera como paga                                                       |
| MP14 | criar checkout e perder resposta                      | idempotência/reconciliação sem assinatura dupla                            |
| MP15 | trial, primeira cobrança e renovação                  | datas e tolerância seguem domínio atual                                    |
| MP16 | pagamento atrasado/falha de rede                      | distingue dívida de incapacidade de leitura                                |
| MP17 | cancelamento agendado                                 | mantém acesso pago e evita cobrança extra segundo capacidade provada       |
| MP18 | troca de preço/upgrade proporcional                   | data/valor corretos, nenhuma dupla cobrança                                |
| MP19 | recurso não equivalente do adapter                    | bloqueio explícito; nenhum método stub devolve sucesso                     |
| MP20 | troca de conta/chave com assinaturas existentes       | valida compatibilidade; não abandona clientes em outra conta               |
| MP21 | links de checkout/portal                              | HTTPS e hosts permitidos, sem open redirect                                |
| MP22 | banco v1 e CHECK de provedor antigo                   | upgrade/reapply seguros, Stripe/Asaas intactos                             |
| MP23 | cron/reconcile sem efeito                             | não audita batida vazia; efeito real auditado                              |
| MP24 | assinatura sintética sandbox roundtrip                | prova browser+API+webhook+releitura, cleanup possível                      |
| MP25 | tentação de rodar teste com credencial real           | guard explícito recusa antes de mutação                                    |
| MP26 | prefixo textual incomum mas conta de teste comprovada | classificação pelo contrato aplicável, sem heurística universal de prefixo |
| MP27 | callback de sucesso sem webhook                       | não marca pago pelo browser                                                |
| MP28 | regressão de Stripe/Asaas                             | suíte comum e fluxos existentes continuam passando                         |

Unit/contract são necessários, mas não substituem smoke real do produto selecionado. O smoke precisa de credencial de teste fornecida/configurada com autorização, conexão isolada e nenhuma base de produção; falta de credencial marca teste como não executado, jamais como sucesso. Confirmar o suporte real a subscriptions no sandbox aplicável e documentar limitações do provedor sem contorná-las com cobrança real.

## 8. Ordem desta frente

MP-A: contrato/capability matrix e pesquisa atual → MP-B: credenciais/wizard e configuração segura → MP-C: adapter/dublê/erro → MP-D: webhook e reconciliação → MP-E: assinatura/troca/cancelamento com evidência → MP-F: sandbox e QA visual/upgrade/distribuição. Checkout de extensões só depois, no O15 do plano principal, usando contrato de pagamento de pedido e merchant da loja.
