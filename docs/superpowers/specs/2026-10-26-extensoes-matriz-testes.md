# Extensões — matriz de testes automatizados e provas de aceite

Data: 26/10/2026. **PLANEJADO, NÃO EXECUTADO.** Parte do [desenho](2026-10-26-extensoes-plataforma-design.md) e do [plano](../plans/2026-10-26-extensoes-plano-execucao.md). IDs são rastreabilidade de requisitos/cenários; o executor pode parametrizar casos, mas não declarar cobertura por quantidade de linhas. Casos de integração exigem dependências reais quando essa realidade é o que está sendo medido.

## 1. Como classificar e executar

| Camada             | Runner/local existente                              | O que prova                                                 | O que não prova sozinha                      |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Unit puro          | Vitest, testes colocalizados `*.test.ts`            | parser, política, solver, dinheiro, state machine           | RLS, banco instalado, sessão ou UX           |
| Componente         | Vitest/Testing Library `*.test.tsx`                 | render, estados, acessibilidade semântica e interação local | instalação fresca, browser real, backend     |
| Cercas estruturais | `pnpm cercas`, `tests/unit/`, AST quando adequado   | ausência de bypass/import indevido; wiring e contratos      | comportamento de domínio sem teste funcional |
| Contrato/rota      | Vitest com handlers reais + adapters controlados    | auth, payload, erro, idempotência e apresentação            | PostgREST real se stubbed                    |
| Invariantes DB     | `pnpm test:db`, `tests/invariants/`                 | schema real, grants, RLS, FKs, concorrência                 | UX ou rede de fornecedor                     |
| Upgrade com dados  | `pnpm test:db:update` e fixtures reais sintéticas   | baseline reaplicável, preservação e healing                 | qualidade da tela                            |
| E2E                | Playwright `tests/e2e/` contra Supabase local real  | jornada UI+backend+DB e evidência visual                    | compatibilidade do gateway real se só dublê  |
| Jornadas           | `pnpm test:journeys` conforme harness existente     | passagem entre superfícies/jornadas                         | substituir E2E exigido por CI                |
| Shell/self-host    | `pnpm test:shell`                                   | scripts, backup, scheduler, layout/imagens da entrega       | migração lógica sem DB                       |
| Build/distribuição | workflow `perf.yml`, `pnpm build`, check de imagens | compilação, packaging, origem dos recursos                  | licença ou segurança da aplicação            |
| Sandbox real       | ensaio opt-in isolado com gateway/loja de teste     | API real e roundtrip suportado                              | nenhum pagamento/cliente real permitido      |
| Falha/carga        | testes determinísticos de caos + medição controlada | recuperação, recursos, timeouts e concorrência              | SLA prometido sem medição representativa     |

`pnpm gov:verify` não engloba DB, E2E e shell. Ler scripts atuais em `package.json`, matrizes nos workflows e `FORA_DO_CI`; não copiar contagens de documentação velha. Teste novo deve entrar no runner certo e rodar no CI que mede o requisito. Não pôr DB/E2E na seleção unitária para “ficar verde”.

## 2. Fixtures compartilhadas e oráculos

Criar `tests/fixtures/extensions-v2/` com pacotes: guia v1 válido, tema v1, data v1 com registros, v2 simples, base/complemento, dependência compartilhada, ciclo, mesma versão alterada, configuração incompatível, permissão nova, dado pessoal/sensível, origem não verificada, loja paga e pacote não editável. Criar ZIPs malformados em memória no teste; não commitar arquivos enormes/bombas reais.

Personas: tenant A e B, admin A/B, manager/agent/viewer, usuário removido, suporte readonly, suporte com escrita permitida, superadmin ativo/revogado, token tenant válido/sem scope/revogado, credencial plataforma válida/revogada. Vendedor e comprador são instâncias distintas com contas de nomes/e-mails diferentes; uma pessoa pode acumular papéis sem misturar seus grants.

Relógio e IDs controlados por injeção; sem sleeps longos. Gateway, DNS, HTTP e Storage aceitam adapters para falhas. Nos invariantes, ao menos duas conexões Postgres reais para corridas e transações intercaladas. Oráculo inclui estado persistido, número de efeitos, recibo, evento, autor, conteúdo visível e ausência de vazamento. O mesmo teste que prova sucesso precisa de controle negativo quando o contrato é autorização.

## 3. Regressão de legado — LEG

Arquivos: ampliar `lib/extensions/{manifest,service,requests,instalada,download}.test.ts`, `tests/invariants/extensoes-declarativas.test.ts` e E2E existentes.

| ID    | Preparação e ação                                       | Resultado obrigatório                                                        |
| ----- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| LEG01 | instalar JSON v1 oficial sem novos campos               | mesmo fluxo e resultado de antes; nenhum requisito de loja/licença/Git       |
| LEG02 | abrir seis portas legadas com `card_id` correto         | destino certo por capacidade; não abrir Tarefas por fallback                 |
| LEG03 | tema ativo em A, desligado em B                         | tokens só em A; tema ausente não quebra layout                               |
| LEG04 | documento v1 com chave v2/dependência                   | recusado por parser v1 estrito                                               |
| LEG05 | mesmo pacote antes/depois do upgrade                    | IDs, digest, configurações e revisão preservados                             |
| LEG06 | recibo antigo de install/update/revert/remove/configure | legível, sem migração fictícia de autoria                                    |
| LEG07 | último desfazer legado após upgrade                     | revisão respeitada e histórico novo consistente                              |
| LEG08 | instalação removida com vínculos antigos                | continua removida; upgrade não reativa                                       |
| LEG09 | catálogo indisponível no reinício                       | pacote já instalado continua usável localmente                               |
| LEG10 | objeto `data` v1 com registros existentes               | painel/valores/referências intactos após backfill                            |
| LEG11 | metadado/operação mais nova desconhecida                | degradação visível sem derrubar lista inteira                                |
| LEG12 | zero extensões, flags loja/autoria off                  | jornadas de contatos/inbox/agenda/agentes iguais; nenhuma chamada de licença |

## 4. Parser e ZIP — PKG

Arquivos propostos: `lib/extensions/manifest-v2.test.ts`, `zip.test.ts`, `package-format.test.ts`, `releases.test.ts`.

| ID    | Entrada/ação                                                           | Oráculo                                                  |
| ----- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| PKG01 | v2 mínima válida                                                       | schema e inventário determinísticos                      |
| PKG02 | chave desconhecida em cada nível                                       | recusa com caminho; nenhuma escrita parcial              |
| PKG03 | JSON com duplicatas/prototype/NUL/surrogates inválidos                 | recusa antes de JSONB                                    |
| PKG04 | profundidade/nós/strings no limite e acima                             | limite aplicado nos bytes/estrutura reais                |
| PKG05 | ZIP sem `extension.json` ou duas raízes candidatas                     | recusa explícita; não escolher primeiro arquivo          |
| PKG06 | `../`, `/abs`, drive Windows, `\\`, Unicode/path normalizado duplicado | recusa path traversal e colisão                          |
| PKG07 | symlink/hardlink e nomes equivalentes por case                         | recusa conteúdo ambíguo/fora da raiz                     |
| PKG08 | tamanho compactado pequeno, expandido excessivo                        | aborta antes do consumo ilimitado                        |
| PKG09 | tamanho declarado falso, stream truncado, CRC inválido                 | não publica artefato incompleto                          |
| PKG10 | executável, script de install, SQL, HTML ativo ou SVG não permitido    | recusa; nenhum eval/import/write em app                  |
| PKG11 | mesma identidade+versão com bytes alterados                            | conflito, release original intacta                       |
| PKG12 | upload repetido de bytes idênticos com mesma chave                     | mesmo recibo; sem publicação duplicada                   |
| PKG13 | mesmo digest por outra origem                                          | armazenamento pode deduplicar; direitos e identidade não |
| PKG14 | manifesto entre host_api min/max válido e inválido                     | recusa incompatível antes de aplicar                     |
| PKG15 | versão malformada/prerelease fora do canal                             | recusa e mensagem específica                             |
| PKG16 | package_sha versus sha do manifesto divergentes                        | detecta separadamente, sem confundir formato legado      |

## 5. Identidade, RBAC e política — AUTH/POL

Arquivos: `policy.test.ts`, `auth.test.ts`, testes de rotas e `tests/invariants/extensoes-v2-autorizacao.test.ts`.

| ID     | Cenário                                                | Resultado                                                 |
| ------ | ------------------------------------------------------ | --------------------------------------------------------- |
| AUTH01 | viewer/agent/manager chama cada mutação administrativa | 403, zero efeito, sem segredo na resposta                 |
| AUTH02 | admin A muda vínculo A permitido                       | sucesso, ator e org corretos                              |
| AUTH03 | admin A escolhe ID de B em path/body/header            | nega sem revelar conteúdo B                               |
| AUTH04 | troca de org em outra aba após render                  | precondição do contexto falha; nenhuma ação na org errada |
| AUTH05 | token tenant tem `organization_id` B nos args          | org vem do token; tentativa recusada                      |
| AUTH06 | token tenant com scope de texto `platform:*`           | não se torna principal de plataforma                      |
| AUTH07 | superadmin revogado durante preparo                    | apply revalida e recusa                                   |
| AUTH08 | membership/admin retirado entre plan e commit          | recusa no ponto de efeito                                 |
| AUTH09 | suporte readonly tenta upload/apply/config             | guard impede antes do efeito                              |
| AUTH10 | concessão de suporte escrita expira no meio            | sem commit fora da concessão                              |
| AUTH11 | endpoint bearer novo sem sessão                        | proxy permite alcançar guard; token real é validado       |
| AUTH12 | endpoint “público” sem credencial administrativa       | não alcança alteração privada                             |
| POL01  | ZIP global false e tenant override true                | nega por teto global                                      |
| POL02  | default global true, org ausente                       | herda; vale para organização criada depois                |
| POL03  | default true e override false                          | nega só aquela org, mostra razão                          |
| POL04  | mudar política depois do plano                         | stale/replan, sem efeito com política velha               |
| POL05  | ocultar loja de usuários                               | não altera vínculo nem silencia recurso ativo             |
| POL06  | instalar não implica ativar                            | todas orgs mantêm decisões anteriores                     |
| POL07  | disponibilizar para rede com B desativado              | B continua desativado                                     |
| POL08  | fonte tenant privada A                                 | B e público não conseguem listar/baixar                   |
| POL09  | superadmin consulta situação B                         | recebe status autorizado, não dados internos de extensão  |
| POL10  | ação de rede em lote parcialmente falha                | recibos por alvo, resultado real, retry só pendentes      |

## 6. Banco, grants e schema — DB

Arquivos: `tests/invariants/extensoes-v2-rls.test.ts`, `extensoes-v2-schema.test.ts`, `extensoes-v2-corridas.test.ts`, ampliar compilador e gates existentes.

| ID   | Ensaio real                                               | Invariante                                                  |
| ---- | --------------------------------------------------------- | ----------------------------------------------------------- |
| DB01 | SELECT/INSERT/UPDATE/DELETE em cada tabela tenant A/B     | matriz de RLS por operação, não só SELECT                   |
| DB02 | anon/authenticated chamam cada RPC nova                   | EXECUTE recusado conforme contrato                          |
| DB03 | default ACL Supabase de tabelas/funções habilitado        | revokes efetivos; não depender só do GRANT emitido          |
| DB04 | service role tenta operação com ator sem direito          | função verifica ator/papel/escopo; nega                     |
| DB05 | FK de contato/lead/arquivo de B em linha A                | FK composta/validador bloqueia                              |
| DB06 | mesmo slug em duas fontes + nomes longos                  | nenhum objeto resolve tabela errada/truncada                |
| DB07 | duas instalações com mesmo nome apenas                    | resolvedor usa identidade completa, sem `.limit(1)` ambíguo |
| DB08 | constraint v2 aplicada sobre dados legados válidos        | sem quebra de v1; backfill idempotente                      |
| DB09 | registro legado em estado removido/novo desconhecido      | não apagado/reativado pelo upgrade                          |
| DB10 | tentar editar release/histórico/recibo por papel indevido | append-only/imunidade conforme contrato                     |
| DB11 | duas emissões concorrentes do mesmo pedido                | uma licença por direito comprado                            |
| DB12 | duas ativações no último slot disponível                  | somente uma vence, limite não ultrapassa                    |
| DB13 | worker vencido tenta concluir com fencing antigo          | recusa; não desfaz vencedor                                 |
| DB14 | baseline completo aplicado duas/três vezes                | mesmo schema/linhas relevantes, sem duplicar efeitos        |
| DB15 | rollback de transação depois da compilação de objeto      | ponteiros e tabelas/registry não ficam pela metade          |
| DB16 | consultar pg_get_functiondef após baseline                | valida ÚLTIMA definição efetiva e não trecho antigo         |

## 7. Dependências — DEP

Arquivos: `dependencies.test.ts`, `tests/invariants/extensoes-v2-dependencias.test.ts`, `tests/e2e/extensoes-v2-dependencias.spec.ts`.

| ID    | Grafo/ação                                            | Resultado                                           |
| ----- | ----------------------------------------------------- | --------------------------------------------------- |
| DEP01 | A exige B que exige C                                 | plano ordenado C,B,A; lock de versões fixado        |
| DEP02 | A e D exigem mesma B compatível                       | uma B, sem instalação duplicada                     |
| DEP03 | ciclo A->B->C->A                                      | recusa e explica caminho                            |
| DEP04 | ranges de B incompatíveis                             | nenhuma mudança; lista conflitos                    |
| DEP05 | opcional ausente                                      | capacidade dependente não aparece; base funciona    |
| DEP06 | base instalada mas desligada na org                   | complemento não ativa sem consentimento da base     |
| DEP07 | desligar base com dois dependentes                    | preview e confirmação do conjunto, sem apagar dados |
| DEP08 | admin tenant tenta atualizar base usada por B         | proposta para plataforma; B intacta                 |
| DEP09 | novo release quebra contrato de complemento instalado | auto/manual update bloqueados                       |
| DEP10 | prerelease satisfaz número mas canal é estável        | não instala prerelease                              |
| DEP11 | fonte retirada ou namespace mudou durante preparo     | plano inválido; não muda para outro publicador      |
| DEP12 | rollback base abaixo do mínimo do complemento         | bloqueado ou plano conjunto explícito               |

## 8. Recibos, falhas e rollback — OPS

Arquivos: `execution.test.ts`, `history.test.ts`, `backup.test.ts`, invariantes e E2E recuperação.

| ID    | Falha/interleaving                             | Resultado                                                 |
| ----- | ---------------------------------------------- | --------------------------------------------------------- |
| OPS01 | mesma chave+mesmo fingerprint em retry         | mesmo recibo, um efeito                                   |
| OPS02 | mesma chave+payload alterado                   | 409, nenhum segundo efeito                                |
| OPS03 | duas confirmações simultâneas de plano         | uma transição; resposta consistente                       |
| OPS04 | resposta HTTP perdida depois do commit         | consulta mostra concluído, retry não reaplica             |
| OPS05 | timeout antes de saber resultado               | UI mostra consultar/unknown, não sucesso falso            |
| OPS06 | cancela no meio do download                    | conclusão tardia não publica                              |
| OPS07 | nova admissão/revisão durante preparo          | invalida plano/autoridade antiga                          |
| OPS08 | core update ativo contra package update        | coordenação vigente recusa conforme contrato              |
| OPS09 | backup obrigatório falha ou disco insuficiente | versão atual continua, erro acionável                     |
| OPS10 | upload de blob ok e commit DB falha            | órfão em quarentena/GC; nunca release ativa incompleta    |
| OPS11 | DB ok e UI perde evento realtime               | reload mostra estado canônico                             |
| OPS12 | selecionar versão antiga compatível            | troca auditada; histórico múltiplos passos intacto        |
| OPS13 | schema novo incompatível com código antigo     | rollback rápido bloqueado; plano de recuperação informado |
| OPS14 | dados B mudam após snapshot global de A        | não restaurar DB inteiro automaticamente                  |
| OPS15 | reinício worker durante mudança                | claim/reconcile retoma idempotente                        |
| OPS16 | artefato anterior ausente/corrompido           | detecta antes de apontar; caminho de recuperação          |
| OPS17 | cache de tela/runtime depois da troca          | invalidado após commit, sem versão híbrida silenciosa     |
| OPS18 | falha audit complementar                       | recibo canônico preservado; alerta/log de falha audit     |

## 9. MCP, autoria e CLI — MCP

Arquivos: `lib/mcp/tools/extensions.test.ts`, `publication-grants.test.ts`, rotas e contrato em servidor MCP real.

| ID    | Ação                                                     | Resultado                                                            |
| ----- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| MCP01 | tools/list para viewer/agent/admin                       | só elegíveis; handler também nega chamada nominal indevida           |
| MCP02 | agente comercial tenta tool administrativa               | negado mesmo que o nome seja conhecido                               |
| MCP03 | admin cria rascunho próprio, lista/lê todos arquivos     | inventário paginado completo com digests; sem truncamento silencioso |
| MCP04 | ler/escrever/exportar extensão paga não editável         | 403 em todas superfícies, não só botão oculto                        |
| MCP05 | gratuita mas autoria global desabilitada                 | edição/criação negadas; uso continua                                 |
| MCP06 | arquivo do workspace de outro tenant/usuário             | não revela conteúdo nem existência privada                           |
| MCP07 | path traversal na tool de arquivos                       | recusa antes de Storage/FS                                           |
| MCP08 | agente manda `confirmed:true` sem registro humano        | não confirma plano                                                   |
| MCP09 | grant expirado/revogado/token diferente/pacote diferente | nega cada variação                                                   |
| MCP10 | duas publicações consomem último uso do grant            | uma vence atomicamente                                               |
| MCP11 | grant de org usado em alvo de rede                       | nega, sem elevação                                                   |
| MCP12 | UI aprova digest A, MCP substitui ZIP por B              | nega digest divergente                                               |
| MCP13 | grant de janela permite texto, tenta DDL destrutivo      | fora de escopo, exige novo plano/autorização                         |
| MCP14 | validar/exportar só rascunho                             | produz pacote e histórico interno, sem Git remoto                    |
| MCP15 | REST, MCP e CLI submetem mesmo plano                     | mesmos códigos, efeitos, revisões e audit                            |
| MCP16 | token em logs/erros/URL de CLI                           | testes de sanitização não encontram segredo                          |

## 10. Contribuições, dados e privacidade — EXT

Arquivos: `slots.test.ts`, `fields.test.ts`, `data/crud.test.ts`, componentes e invariantes.

| ID    | Cenário                                                       | Resultado                                                               |
| ----- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| EXT01 | campo texto/inteiro/data/dinheiro requerido                   | validação front/back/DB coerente; sem float monetário                   |
| EXT02 | campo lead aproveita schema existente                         | API/import/filter não duplicam valores                                  |
| EXT03 | duas extensões com mesmo field_slug                           | namespace evita colisão; rótulos corretos                               |
| EXT04 | slot inexistente/capacidade não declarada                     | pacote recusado; não render fallback inseguro                           |
| EXT05 | payload tenta HTML/script/event handler CSS                   | texto/bloco seguro; sem execução                                        |
| EXT06 | leitura de dado sem papel ou consentimento                    | campo/cartão/ação não revela informação                                 |
| EXT07 | ação de criar tarefa do host                                  | mesma regra, validação e audit da tarefa nativa                         |
| EXT08 | tool de módulo chamada com pacote desligado                   | handler recusa; não basta sumir da lista                                |
| EXT09 | revogar permissão com job pendente                            | ação não executa com grant velho                                        |
| EXT10 | export de contato com dados da extensão                       | inclui dados pessoais declarados da própria org                         |
| EXT11 | anonimizar contato referenciado                               | cascade/anula coerentes, arquivos removidos conforme política           |
| EXT12 | módulo conectado solicita campo sensível proibido             | nega e registra motivo seguro                                           |
| EXT13 | complemento referencia objeto base fora de tenant             | FK/contrato impede                                                      |
| EXT14 | upgrade adiciona permissão de envio/handoff                   | bloqueia no MVP; nenhum aceite genérico substitui concessão             |
| EXT15 | rollback muda permissões/ações                                | passa pelas mesmas guardas, não reaproveita consentimento errado        |
| EXT16 | fluxo conversacional futuro com mídia sem texto/sem progresso | saída definida, sem conversa presa/muda; execução só na onda autorizada |

## 11. Rede, origem e assinatura — NET

Arquivos: ampliar `download-rebinding.test.ts`, `download.test.ts`; novos `sources.test.ts`, `signatures.test.ts`.

| ID    | Destino/documento                                    | Resultado                                                     |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------- |
| NET01 | loopback/privado/link-local/metadata cloud           | recusado em produção                                          |
| NET02 | IPv6 e IPv4 mapeado, hostname com IP literal         | classificação correta                                         |
| NET03 | DNS resolve público e muda antes de conectar         | socket pinado, sem segunda resolução insegura                 |
| NET04 | lista DNS inclui endereço privado e público          | recusa conjunto inseguro                                      |
| NET05 | redirect para interno ou outra origem                | recusa ou revalida explicitamente sem enviar credencial       |
| NET06 | servidor lento, stream infinito, encoding inesperado | timeout/limite aplicado e sem pacote parcial                  |
| NET07 | token fonte A e download host B                      | token não segue para B                                        |
| NET08 | assinatura válida de publicador errado               | recusa identidade/issuer                                      |
| NET09 | hash correto mas fonte não autorizada                | não instala só por hash                                       |
| NET10 | metadados antigos/replay/expirados                   | bloqueia novas decisões conforme política; instalado continua |
| NET11 | chave legítima rotacionada e cadeia conhecida        | valida rotação sem perder versões recuperáveis                |
| NET12 | chave desconhecida/troca de origem silenciosa        | requer revisão, sem confiança automática                      |

## 12. Licença e auto-update — LIC/UPD

Arquivos: `entitlements.test.ts`, `licenses.test.ts`, `updates.test.ts`; DB ativação e E2E em duas instâncias.

| ID    | Cenário                                                | Resultado                                                        |
| ----- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| LIC01 | pacote gratuito sem política de licença                | nenhum request comercial obrigatório                             |
| LIC02 | assinatura válida com issuer/product/audience certos   | direitos exibidos e cache usados                                 |
| LIC03 | documento alterado/issuer errado/audience errada       | recusa; não limpar dados locais                                  |
| LIC04 | uso perpétuo e updates expirados                       | versão autorizada continua; novas releases bloqueadas            |
| LIC05 | updates vitalícios                                     | nenhum vencimento fictício por null                              |
| LIC06 | indisponibilidade de loja dentro da concessão cacheada | usa cache e aviso, sem falso “inválida”                          |
| LIC07 | nunca validou e loja indisponível                      | estado pendente explícito; não simula licença                    |
| LIC08 | renovação duplicada/replay de confirmação              | direitos estendem uma vez                                        |
| LIC09 | migração/revogação de ativação                         | slot/limite e histórico coerentes                                |
| LIC10 | refund/revogação                                       | comportamento conforme terms_snapshot, não regra nova retroativa |
| UPD01 | auto-update off e release nova                         | só aviso, sem troca                                              |
| UPD02 | política opt-in autoriza release compatível            | plano completo, backup, apply e audit                            |
| UPD03 | nova permissão/dependência incompatível                | não atualiza automaticamente                                     |
| UPD04 | rollout/janela definida, timezone e DST                | aplica uma vez no período correto                                |
| UPD05 | pacote novo corrompido ou licença expira no preparo    | conserva anterior; replanejar                                    |
| UPD06 | endpoint remoto tenta mandar desativar                 | não executa comando remoto                                       |
| UPD07 | reinício offline após atualização autorizada           | usa artefatos presentes sem pull obrigatório                     |
| UPD08 | auto-update falha repetidamente                        | pausa política daquela extensão e abre aviso acionável           |

## 13. OAuth entre instâncias — OAUTH

| ID      | Fluxo/ataque                                        | Resultado                                                         |
| ------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| OAUTH01 | contas com e-mails diferentes em comprador/vendedor | conexão correta por consentimento, sem pressupor identidade igual |
| OAUTH02 | state errado/ausente ou callback repetido           | recusa e code não reutilizável                                    |
| OAUTH03 | verifier PKCE errado/sem S256                       | token não emitido                                                 |
| OAUTH04 | issuer trocado/mix-up na descoberta                 | recusa sem vazar código/token                                     |
| OAUTH05 | redirect URI diferente por detalhe/host             | recusa de correspondência exata registrada                        |
| OAUTH06 | usuário autoriza loja A mas token acessa B          | scope/issuer/store impede                                         |
| OAUTH07 | refresh token rotacionado é reutilizado             | detecta e aplica política de revogação da família                 |
| OAUTH08 | desconectar ou remover acesso do comprador          | novas consultas/downloads falham; pacote/dados locais preservados |
| OAUTH09 | sessão expira durante callback com Strict cookie    | UX retoma autenticação sem reduzir proteção global                |
| OAUTH10 | Device code expirado/negado/poll excessivo          | erro/slow_down suportados sem loop infinito                       |
| OAUTH11 | URL de provedor maliciosa ou interna                | SSRF bloqueado antes de discovery                                 |
| OAUTH12 | tela de consentimento do cliente externo            | nomeia loja/instância/alvo/scopes, não dá membership interno      |

## 14. Loja, vendas, agentes e revenda — SALE/RES

| ID     | Cenário                                                      | Resultado                                                               |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| SALE01 | loja off, zero configuração gateway                          | núcleo normal; rotas opcionais indisponíveis sem 500                    |
| SALE02 | selecionar extensão instalada sem direito de distribuir      | publicação de oferta bloqueada                                          |
| SALE03 | oferta privada/rascunho                                      | não aparece publicamente nem em tools comerciais                        |
| SALE04 | alterar preço depois da cotação                              | pedido usa snapshot aprovado ou pede recotação explícita                |
| SALE05 | confirmar pagamento manual duas vezes                        | uma confirmação/uma emissão, ator registrado                            |
| SALE06 | agente comercial tenta marcar pago manual                    | negado; permissão reservada ao vendedor                                 |
| SALE07 | comprador retorna do checkout “sucesso” sem confirmação      | pedido continua pendente                                                |
| SALE08 | webhook repetido/fora de ordem                               | releitura, um efeito; não regredir pago por evento antigo               |
| SALE09 | gateway de outra conta/valor/moeda/ambiente                  | não libera licença; revisão visível                                     |
| SALE10 | venda concluída sem portal                                   | resgate autenticável previsto e entregue com segurança                  |
| SALE11 | catálogo externo modifica produto vinculado                  | não sobrescreve direitos/preço de pedido fechado                        |
| SALE12 | agente pergunta compatibilidade/preço/instalação             | material aprovado + consulta canônica; não inventa                      |
| SALE13 | documento de plugin contém instrução para dar desconto/admin | conteúdo não altera autoridade do agente                                |
| SALE14 | comprador quer ajuda humana                                  | caso com oferta/pedido/contexto e próximo passo, sem segredo            |
| RES01  | comprador de licença de uso tenta revender                   | nega sem grant                                                          |
| RES02  | titular permite revenda direta                               | loja autorizada publica oferta com autoria preservada                   |
| RES03  | revendedor sem can_subgrant tenta autorizar filho            | nega                                                                    |
| RES04  | filho amplia validade/território/direitos do pai             | nega cada dimensão                                                      |
| RES05  | cadeia cíclica ou profundidade excedida                      | rejeita antes da concessão                                              |
| RES06  | revoga pai com licenças antigas vendidas                     | bloqueia novas vendas, não revoga antigas por suposição                 |
| RES07  | comissão fixa versus percentual versus margem                | exatamente regra escolhida, sem somar duas por acidente                 |
| RES08  | desconto/arredondamento centavos/reembolso parcial           | cálculo monetário determinístico e proporcional conforme termos         |
| RES09  | mesma venda gera allocation em retry                         | uma linha por direito, sem duplicar dívida                              |
| RES10  | marcar repasse manual duas vezes                             | uma liquidação auditada; calculado não aparece como pago                |
| RES11  | dois revendedores publicam mesmo pacote                      | autoria original e ofertas distintas; identidade do artefato preservada |
| RES12  | reembolso depois de repasse manual                           | estorno/pendência explícita; não inventar saldo disponível              |

## 15. Interface, acessibilidade e sistema vivo — UI

E2E propostos: `extensoes-v2-marketplace.spec.ts`, `extensoes-v2-autoria.spec.ts`, `extensoes-v2-mcp-publicacao.spec.ts`, `extensoes-v2-loja.spec.ts`, `extensoes-v2-licencas.spec.ts`. Integrar ao harness e matrizes existentes sem excluir para acelerar verde.

| ID   | Jornada                                        | Evidência                                                           |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------- |
| UI01 | leigo encontra loja pela navegação             | menu e destino corretos por papel, sem digitar URL                  |
| UI02 | catálogo vazio/offline/negado                  | mensagens distintas e próximo passo                                 |
| UI03 | buscar categoria/família/complemento           | resultados e dependências compreensíveis                            |
| UI04 | instalar ZIP válido e inválido                 | progresso real, erros por arquivo e sucesso confirmado pelo recibo  |
| UI05 | pacote pede nova permissão                     | efeito em linguagem clara, aceite explícito e recusa funcional      |
| UI06 | duas abas concorrem em configuração/update     | stale explicado e reload sem perder dados silenciosamente           |
| UI07 | superadmin opera tenant selecionado            | alvo sempre visível e confirmado no plano                           |
| UI08 | tenant oculta loja/desliga autoria             | interface condiz com backend; uso ativo permanece alcançável        |
| UI09 | teclado/foco/dialog/leitor de tela             | nomes acessíveis, foco retorna, erro associado ao campo             |
| UI10 | viewport celular/tablet/desktop                | nenhum controle crítico fora da tela ou tabela ilegível             |
| UI11 | PT-BR e idiomas suportados                     | traduções corretas, fallback declarado sem texto técnico cru        |
| UI12 | falha de licença/update vira Central           | responsável vê causa, reautoriza/retoma e aviso resolve             |
| UI13 | remover e reinstalar depois                    | configurações/dados preservados; ativação não reaparece por engano  |
| UI14 | histórico e rollback incompatível              | explica diferença pacote/dados e recuperação possível               |
| UI15 | token gerado/rotacionado                       | uma vez quando previsto, mascarado depois, nunca em screenshot real |
| UI16 | loja compradora/vendedora com marcas distintas | marca correta em cada lado e sem PII de outro tenant                |

## 16. Prova em par para IA

Cada caso que passa por agente deve medir duas execuções com **o mesmo texto cru**: (A) usuário pela tela/chat e (B) ferramenta diretamente em contexto equivalente. Se divergem, não declarar sucesso de domínio com base na resposta do modelo. Usar fixtures sem cliente real; efeito com idempotência evita duplicar compra/envio na comparação.

Pares mínimos: consultar oferta; explicar prazo de updates; cotar complemento sem base; criar checkout; consultar pagamento pendente; recusar desconto fora dos termos; escalar incompatibilidade; tentar instalar sem papel; criar rascunho permitido via assistente externo; negar fonte fechada; publicar com plano já aprovado; negar grant expirado. Guardar input, tool/args saneados, resultado canônico, resposta e efeito no banco. Nunca gravar token/chave nos artefatos.

## 17. Instalação fresca, upgrade e falhas de infraestrutura — HOST

| ID     | Ensaio                                                    | Aceite                                                         |
| ------ | --------------------------------------------------------- | -------------------------------------------------------------- |
| HOST01 | clone fresco sem extensões/loja/chaves extras             | sobe sem editar env manualmente                                |
| HOST02 | upgrade de banco com guia/tema/data v1 e recibos          | preserva linhas e jornadas                                     |
| HOST03 | reapply baseline e atualização subsequente                | idempotente e sem reaplicar side effects                       |
| HOST04 | backup inclui bucket de extensões e metadados             | inventário e restauração comprovados no ensaio                 |
| HOST05 | instalação multi-tenant tenta baixar backup via UI tenant | nega dump global                                               |
| HOST06 | disco cheio / Storage falha / banco indisponível          | fail seguro, diagnóstico, versão anterior preservada           |
| HOST07 | cron update sem tarefa                                    | nenhuma audit vazia; com tarefa audita efeito                  |
| HOST08 | app/worker/scheduler atualizados em conjunto              | schemas/contratos coerentes e pacote novo alcançável           |
| HOST09 | imagem anterior sobe após evolução aditiva                | leitor antigo suporta estado ou rollback bloqueado previamente |
| HOST10 | local-only artefact no reinício offline                   | não exige rede para pacote instalado                           |
| HOST11 | AMD64/ARM64 suportadas pelo produto                       | packaging/runtime ensaiados, sem afirmar suporte não medido    |
| HOST12 | GC de órfãos com versão ativa/anterior referenciada       | nunca apaga única versão recuperável                           |

Carga/limites: medir catálogo grande, grafo profundo permitido, muitos objetos/campos, várias orgs ativas, downloads concorrentes e instância ociosa. Registrar CPU, RSS/pico, conexões, disco e latência p50/p95/p99. Fixar orçamento só após medição e revisão; número de campos/ZIP não pode ser “ilimitado”. Assinatura/solver/extração têm testes de tempo/consumo determinísticos para entradas adversas sem depender de SLA de internet.

## 18. Controles de sensibilidade e sabotagem

Antes do teste crítico, escrever qual caso ficará vermelho se a guarda for retirada. Exemplos: retirar filtro organization_id; permitir scope de plataforma no token tenant; ignorar `expected_revision`; aceitar digest diferente no mesmo version; desativar check da nova permissão; apagar lock de limite de ativação; tratar webhook como pago sem releitura; seguir redirect levando Authorization; permitir import/eval do pacote; restaurar DB global ao clicar rollback tenant. Medir falha esperada e restaurar byte a byte. Na árvore compartilhada, sabotagem só em arquivos sob controle da task e com isolamento de execução por adapter/patch controlado; nunca usar stash/reset global ou interferir em trabalho de outro agente.

Não contar teste que só repete a implementação. Uma cerca textual pode provar posição de um guard, mas um teste funcional separado precisa demonstrar que a remoção causaria o efeito indevido. Dublê de gateway deve ter teste de conformidade contra sandbox real quando disponível, para não validar um protocolo inventado.

## 19. Gates e evidência de fechamento

Para cada entrega: IDs de requisitos cobertos, arquivos e commits, comandos/exit codes, fixture e resultados, falhas preexistentes identificadas por evidência, cenários não medidos e limitações. Screenshots somente sintéticos; arquivos em `docs/evidence/` conforme convenção vigente. DB: estado antes/depois e contagens que não podem mudar. Navegação e arquitetura: mapa JSON e checklist com consumidores reais.

Comandos de referência, a reconferir no checkout antes de executar:

```bash
pnpm vitest run lib/extensions/<arquivo-real>.test.ts
pnpm cercas
pnpm gov:verify
pnpm test:db tests/invariants/<arquivo-real>.test.ts
pnpm test:db:update
pnpm playwright test tests/e2e/<arquivo-real>.spec.ts
pnpm test:journeys
pnpm test:shell
pnpm checar:colisao-de-migration
pnpm release:conferir
```

Placeholders `<arquivo-real>` são substituídos pelos arquivos criados na onda; não executar literalmente. Build/imagens via fluxo permitido do fork/CI e gates atuais. Nunca iniciar Docker no Mac, nunca usar `.env.e2e` de produção e nunca misturar cobrança de teste com credencial real. Mercado Pago tem matriz própria no anexo; seus testes de sandbox não são executados pelo CI comum com credenciais reais.
