# Telegram para colaboração da equipe em grupos e casos humanos

> **Status:** implementação autorizada pelo usuário em 2026-10-26; em execução e validação nesta branch local.
> **Escopo:** permitir que grupos de Telegram escolhidos pela organização recebam avisos de casos originados em qualquer canal e que operadores autorizados coordenem casos pelo próprio grupo, com apoio controlado de IA.
> **Princípio de configuração:** Conexões é a fonte canônica das configurações por grupo. Casos → Avisos consulta e altera os mesmos registros; não mantém uma cópia paralela das permissões.
> **Base consultada:** checkout `codex/telegram-vps-compatible`, estado em 2026-10-26. Os números de linha abaixo são referências ao checkout consultado e devem ser revalidados no início da implementação.

## 1. Decisão de produto recomendada

Implementar o grupo como um **espaço interno de colaboração**, separado das conversas com clientes. O grupo pode ter capacidades independentes:

1. receber mensagens na Inbox humana;
2. receber avisos resumidos de casos humanos;
3. permitir que operadores autorizados consultem e conduzam casos pelo bot;
4. permitir uma assistência de IA limitada à conversa interna de casos.

Cada capacidade deve ter um controle separado, explicação de efeito e pré-requisitos visíveis. Ligar o grupo à Inbox não liga IA. Escolher um grupo para avisos não importa as mensagens dele para o CRM. Permitir que alguém acompanhe o grupo não permite que essa pessoa atue em casos.

**Recomendação para o comportamento da IA:** mensagens que respondam diretamente a uma mensagem do bot/caso têm prioridade e podem iniciar a interpretação da ação pretendida. Mensagens sem reply só são consideradas quando existe um caso ou uma pergunta ativa que as torne contextualmente relevantes. Se houver mais de um caso plausível, a IA apresenta opções e pede escolha. Nenhuma mensagem ambígua deve alterar caso nem ser enviada ao cliente.

**Recomendação para entrada de membro desconhecido:** fail closed. Se houver evidência de novo membro ou lacuna de sincronização de membros, suspender a assistência de IA e as ações de casos naquele grupo e avisar a equipe. Reativar somente após um administrador reconciliar os membros e conceder as permissões. Pessoas não autorizadas podem acompanhar o que o próprio grupo Telegram lhes mostra, mas suas mensagens não podem acionar ações do CRM.

## 2. O que existe hoje

### 2.1 Grupos na Inbox são uma allowlist humana

- `docs/superpowers/plans/2026-10-17-telegram-primeira-fatia.md:1-4` descreve Telegram com webhook, Inbox privada/grupos e allowlist, sem IA em grupos.
- `lib/channels/telegram/ingest.ts:22-40` reconhece mensagens privadas e de grupo/supergrupo e ignora remetentes bot.
- `lib/channels/telegram/ingest.ts:69-96` só aceita grupo quando a conexão concede `group_messages` e `receive_messages`; grupos descobertos nas atualizações começam desabilitados e só a allowlist explícita os libera.
- `lib/channels/telegram/ingest.ts:98-138` persiste grupo como contato/conversa de grupo e força `inboxOnly` para grupos.
- `supabase/migrations/20261024000000_0708_telegram_inbox_groups.sql:1-7` permite IDs numéricos Telegram na tabela de grupos, além dos IDs `@g.us` do WhatsApp.
- `supabase/migrations/20260928150400_0482_grupos_na_inbox.sql:31-45` define `channel_session_groups`; `enabled` é o aceite da Inbox. As linhas 48-66 restringem escrita a API/service role com leitura tenant-scoped.
- `supabase/migrations/20260928150400_0482_grupos_na_inbox.sql:78-110` protege o invariante atual: grupo não recebe roteamento e mensagens emitem `message.group_received`, fora do pipeline `message.received` que pode ativar IA, follow-ups e automações.
- `docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md:10-25` registra a intenção original: grupos selecionados, atendimento humano, sem IA.

### 2.2 O webhook ainda não processa interação de equipe

- `app/api/v1/webhooks/telegram/[token]/route.ts:20-23` classifica hoje `message`, `edited_message`, `channel_post` e `edited_channel_post`; `callback_query`, `chat_member` e `my_chat_member` ainda caem em `other`.
- `app/api/v1/webhooks/telegram/[token]/route.ts:25-91` autentica segredo, valida update ID e persiste updates de forma idempotente para processamento posterior.
- `lib/channels/telegram/bot-api.ts:137` usa por padrão `allowed_updates: ["message"]`; recebimento de callback de botões e eventos de membros exige ampliar e reconciliar explicitamente essa lista.

### 2.3 Existem bindings de uso do bot, mas não os consumidores desta proposta

- `supabase/migrations/20261022000000_0703_telegram_bot_connections.sql:44-65` admite superfícies `inbox`, `team_alerts`, `human_cases`, `agent_tools` e `mini_app`; o comentário deixa claro que binding sozinho não produz efeito.
- `...0703_telegram_bot_connections.sql:76-101` admite capacidades `team_alerts/send_alerts` e `human_cases/read_cases,reply_to_cases`, além das capacidades Inbox.
- `app/api/v1/channels/telegram/route.ts:23-65` ainda só aceita `surface: "inbox"`; a UI de configuração do bot também precisa expor os novos usos depois que consumidores reais existirem.

### 2.4 Avisos de casos são hoje centrados em WhatsApp

- `app/app/ai/cases/avisos/_components/AvisoNoWhatsApp.tsx:151-170` filtra conexões que aceitam mensagem livre, mas o formulário ainda escolhe um telefone.
- `app/api/v1/ai/cases/alerta/route.ts:60-80` valida `channel_session_id`, telefone E.164, rótulo e estado ligado.
- `...route.ts:124-180` lê e grava a configuração de `config_aviso_de_caso` pelo RPC protegido `fn_definir_aviso_de_caso`.
- `supabase/migrations/20260918121000_0292_aviso_de_caso_no_whatsapp.sql:88-100` define uma configuração por organização. A mesma migration cria `entregas_de_aviso_de_caso`, com idempotência por organização, caso e destino (`:170-238`).

### 2.5 O fluxo de caso já tem uma transição de domínio que precisa ser reutilizada

- `app/api/v1/ai/cases/[id]/reply/route.ts:59-70` define ações `resolved`, `need_lead_info` e `escalate` e seus estados resultantes.
- `...route.ts:82-120` exige usuário autenticado, papel e organização atuais e busca o caso sob o tenant; IDs e permissões não devem ser aceitos cegamente do Telegram.
- `...route.ts:209-260` executa transição, enfileiramento da continuação e auditoria como uma operação coordenada.
- `lib/agent-engine/agent/case-reply-turn.ts:71-99` recupera a conversa e a sessão de canal que pertencem ao caso, não a conversa mais recente do contato.

Esses pontos mostram que o Telegram pode ser o **canal interno de operação** para casos originados em WhatsApp, Instagram, Facebook ou Telegram, desde que o registro do caso aponte para uma conversa canônica e o envio de resposta ao cliente funcione pelo adapter daquela conversa. Isso não comprova por si só o caminho Zernio: antes de habilitar esse canal, validar criação de caso, sessão/conversa canônica, permissão de resposta, janela/política do provider e envio real de volta pelo Zernio.

## 3. Modelo conceitual e fonte única de verdade

### 3.1 Entidades e responsabilidades

| Registro                                                                         | Responsabilidade                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conexão Telegram                                                                 | Bot, credencial cifrada, status, webhook e identidade do bot.                                                                                                                                                                            |
| `channel_session_groups` (ou a entidade canônica de grupos confirmada na Onda 0) | Grupo remoto observado para uma sessão; `enabled` mantém o significado atual de entrada na Inbox humana.                                                                                                                                 |
| Configuração do grupo                                                            | Capacidades do grupo: Inbox, avisos de caso, ações de caso, assistente interno; estado da segurança/sincronização de membros. Deve haver uma linha canônica por organização + conexão/sessão + chat ID.                                  |
| Participante observado                                                           | Telegram user ID visto naquele grupo, nome/@username apenas como metadado de exibição, presença/estado observado e última atualização.                                                                                                   |
| Vínculo Telegram ↔ usuário CRM                                                   | Prova de identidade e associação revogável ao usuário autenticado. Não confiar em nome, username ou telefone informado. Reutilizar o vínculo seguro existente se houver; caso contrário, criar domínio próprio.                          |
| Permissões do participante no grupo                                              | Grants por grupo e finalidade, por exemplo `can_use_assistant`, `can_act_on_cases`, `can_approve_members`. Não elevam papel CRM.                                                                                                         |
| Destino de aviso de caso                                                         | Referência à configuração canônica do grupo selecionado (ou destino individual existente); não copia permissões do grupo.                                                                                                                |
| Entrega de aviso                                                                 | Uma tentativa lógica por organização + caso + destino, idempotente, contendo estado/código de erro e IDs remotos necessários para localizar ou atualizar a mensagem. Não guardar cópia do resumo ou do corpo do cliente sem necessidade. |
| Ação de caso via Telegram                                                        | Registro de correlação entre update, ator pareado, caso, ação e resultado, com auditoria. Só registra como ação as mensagens explicitamente associadas ao caso/ação.                                                                     |

### 3.2 Como Conexões e Casos → Avisos devem permanecer sincronizados

Sim: ambas as telas devem ler e gravar a mesma fonte de dados no banco. A proposta é:

1. **Conexões → Grupos** edita o registro canônico do grupo e seus grants: entrada na Inbox, elegibilidade para receber avisos, assistência de IA no grupo, ações de casos e estado dos membros.
2. **Casos → Avisos** busca os grupos elegíveis a partir desses mesmos registros e escolhe qual deles é o destino ativo da organização. O formulário salva somente a referência do destino e o estado global do envio de avisos em `config_aviso_de_caso` (evoluída para destino tipado), sem replicar nome, permissões ou `enabled` do grupo.
3. Ao mudar em Conexões a elegibilidade do grupo, Avisos deixa de oferecê-lo ou sinaliza que o destino salvo ficou indisponível. Ao escolher ou trocar o destino em Avisos, o cartão em Conexões mostra imediatamente “Destino atual de avisos”. Ambos refletem os mesmos IDs e timestamps consultados no servidor.
4. Mutations devem invalidar/refazer as queries compartilhadas ao concluir. Realtime pode ser uma melhoria; consistência não pode depender de uma conexão realtime aberta. Em caso de falha, exibir erro e não simular a mudança.
5. O servidor valida atomicamente que o grupo referenciado pertence à organização, conexão ativa, capacidade habilitada, grupo selecionado/observado e membro ainda elegível. FKs compostas ou RPC transacional evitam referência cruzada entre tenants.

O campo `channel_session_groups.enabled` **não** deve ser reaproveitado como “avisos ligados” nem “IA ligada”: isso mudaria a semântica existente de Inbox. O mesmo registro pode ser estendido, depois de auditoria do schema, com campos/capacidades explícitos; ou receber uma tabela de configuração 1:1 com FK única. Em qualquer alternativa, deve haver um único registro autoritativo para cada opção funcional, e os dois lugares da UI devem escrever nele. Não fazer duas colunas espelhadas entre telas.

### 3.3 Compatibilidade e tenant isolation

- Manter a allowlist atual e seus efeitos: grupo desligado continua fora da Inbox, mesmo se for destino de avisos, a menos que produto decida explicitamente que a descoberta/seleção basta para avisos. Recomenda-se não exigir Inbox para aviso de caso.
- Toda chave inclui `organization_id`; referências incluem conexão e `chat_id` normalizado como texto para não perder precisão de IDs Telegram.
- Escrita passa por endpoints/RPC autenticados e auditados. Não conceder escrita direta a `authenticated`; seguir o padrão do `0482`.
- Configuração removida, bot desconectado ou grupo inacessível desliga entregas futuras e informa motivo, sem apagar histórico auditável.

## 4. Interface administrativa proposta

### 4.1 Conexões → Telegram → Grupos

Trocar a lista de linhas simples por cartões por grupo. Cada cartão mostra nome do grupo, @username se público, ID abreviado para diagnóstico, bot responsável, última atividade recebida, número de casos/avisos recentes e badges de estado. Não exibir informação de cliente no card.

Seções/controles independentes:

- **Inbox humana:** “Receber mensagens deste grupo na Inbox”. Ajuda: mensagens ficam no CRM para acompanhamento humano; não implica IA.
- **Avisos de casos:** “Este grupo pode receber avisos”. Ajuda: mensagem de caso será visível a todos os membros do grupo.
- **Ações em casos:** “Operadores autorizados podem consultar e conduzir casos neste grupo”. Requer binding `human_cases` com `read_cases` e/ou `reply_to_cases` conforme ações habilitadas.
- **Assistente interno de IA:** “Assistente ajuda a equipe neste grupo”. Desligado por padrão; exige evento de mensagem, contexto autorizado, estado de membros saudável e pelo menos um administrador.
- **Membros observados:** lista de participante, estado (identificado/desconhecido/removido/não verificado), usuário CRM pareado (se houver), última atualização e grants “Pode usar assistente”, “Pode agir em casos”, “Pode aprovar membros”. Permitir revogar.
- **Estado de segurança:** indicar bot não administrador, `chat_member` indisponível, privacidade do bot restringindo leitura, membro desconhecido, sincronização vencida, webhook com lacuna e suspensão automática.

As permissões de aprovação não podem ser concedidas a qualquer membro por mensagem natural. Configuração inicial somente por admin do CRM; promoção posterior requer operador com `can_approve_members`, confirmação explícita e auditoria.

### 4.2 Casos → Avisos

Renomear gradualmente “Aviso no WhatsApp” para **“Avisos de casos”**. Permitir escolher um destino individual ou um grupo de equipe elegível, podendo deixar configuração desligada. O seletor de grupo exibe conexão/bot, nome e membros/perfil de visibilidade conhecidos, aviso de que todos os membros podem ler, saúde do bot e se o destino é elegível.

O botão de teste envia mensagem real somente após confirmação do administrador, registra entrega de teste separadamente de aviso de caso e informa o destino exato. Não criar caso artificial nem enviar conteúdo de cliente no teste.

Na edição do grupo e na tela Avisos, mostrar o mesmo badge e valor do destino selecionado. Se o destino escolhido for desabilitado no cartão, apresentar conflito com ação para escolher outro destino; não silently reverter a opção nem mandar para grupo antigo.

### 4.3 Navegação conversacional no grupo

Mensagens do bot oferecem inline buttons com operações de baixo risco e callbacks assinados/opacos:

- “Abrir no CRM” — URL autenticada; não embutir conteúdo sensível em URL.
- “Assumir caso” — se o domínio suportar atribuição/claim, executar como ação atômica com verificação de status; se ainda não houver operação de claim comum, não simular.
- “Orientar resposta ao cliente” — abre fluxo para operador redigir a orientação que o agente repassará ao cliente.
- “Orientar pergunta ao cliente” — operador especifica a informação que o agente deve solicitar ao cliente.
- “Escalar” — apenas se a transição existente estiver definida e for permitida.
- “Ver casos abertos”, “Ver casos fechados” — consulta paginada; casos fechados são somente leitura.

Os botões não autorizam por si mesmos: `callback_query` deve validar user ID, grupo, connection, tenant, expiração, case status e grants atuais antes de executar.

## 5. Fluxos completos

### 5.1 Configuração inicial do bot e grupo

1. Admin conecta bot e escolhe superfícies `inbox`, `team_alerts` e `human_cases` conforme a necessidade. UI só oferece capacidade quando há consumidor implantado.
2. Admin adiciona o bot ao grupo. Para interagir e publicar alertas, o bot precisa poder enviar mensagens. Para receber mensagens comuns e eventos de membros, permissões e privacidade do bot devem satisfazer os requisitos Telegram; instruir a promover a admin quando necessário, explicando que a plataforma passa a entregar conteúdo do grupo ao CRM.
3. Webhook descobre o grupo em uma atualização; o grupo aparece com estado “Descoberto — ainda não habilitado”. Identificação não equivale a confiança nem a consentimento.
4. Admin abre o cartão, verifica nome/ID e escolhe os usos. Para enviar casos, uma confirmação informa que detalhes e categorias serão visíveis para todos os membros.
5. Antes de ligar assistência/ações, o CRM verifica recursos de membership. Se não for possível manter um inventário confiável (bot sem admin, atualização requerida não ativa, webhook atrasado), mantém recursos desligados e explica por quê.
6. Admin pareia operadores pelo fluxo já existente e concede grants individualmente para cada grupo.
7. A tela Casos → Avisos pode então escolher este destino elegível. A escolha é salva como referência ao registro canônico, não uma cópia de grants.

### 5.2 Aviso quando caso de qualquer canal é aberto

1. Um caso é criado para uma conversa canônica; origem pode ser WhatsApp, Telegram, Instagram/Facebook por Zernio ou outro canal compatível.
2. Evento de domínio do caso entra na fila existente de aviso. O worker resolve configuração global e destino ativo no momento do envio.
3. Valida conexão/bot ativo, `team_alerts/send_alerts`, grupo elegível, membership state saudável, capacidade de envio, e que destino ainda pertence à organização.
4. Monta um aviso mínimo: identificador curto, título/categoria/prioridade aprovados para divulgação, estado, origem do canal em nível genérico, resumo sanitizado e link para abrir CRM. Não inclui telefone, transcript, anexos, `context_snapshot`, endereços ou dados pessoais desnecessários.
5. Persiste tentativa idempotente por organização + caso + destino e chama o adapter Telegram. Guarda `message_id` remoto e status sem duplicar o texto do caso no log.
6. Erro transitório usa retry com limite/backoff; erro permanente (bot removido, sem permissão, destino não encontrado) gera estado visível na tela Avisos/Central de alertas. Não troca silenciosamente para um WhatsApp ou outro grupo.
7. Se destino mudar enquanto envio está em execução, a chave/idempotência e transação devem definir se o evento usa configuração capturada ou corrente. Recomendação: capturar uma versão/config ID no momento de enfileirar, enviar ao destino aprovado para aquela tentativa e não enviar duplicata ao novo; mudança de destino vale para casos posteriores. Reenvio manual cria tentativa explícita e auditada ao destino atual.

### 5.3 Consulta e condução de caso no grupo

1. Uma mensagem no grupo é classificada como comando/intenção operacional somente no runtime interno novo; nunca é entregue ao runtime normal do cliente.
2. Resolve identidade por `connection_id + chat_id + from.id`; exige vínculo Telegram válido com usuário CRM ativo na organização e grants daquele grupo. Username/nome exibido não servem como prova.
3. Define o alvo: (a) reply a mensagem do bot/caso → caso associado à mensagem citada; (b) callback assinado → alvo registrado no payload servidor; (c) texto sem referência → localizar pergunta/ação pendente recente no grupo; se houver um único alvo plausível, apresentar resumo e pedir confirmação antes de mutação; se houver vários, oferecer botões de seleção; se nenhum, responder como conversa geral sem executar alteração.
4. Consultas de caso aberto/fechado são sempre limitadas à organização do operador e grants. Paginar, limitar dados e mascarar contato. Caso fechado não admite ação de escrita.
5. “Orientar resposta ao cliente” cria uma instrução/turno ligado ao caso e usa o mesmo serviço de domínio da UI para transição e enqueue. O agente continua na conversa do cliente original via `case_reply_turn`; o grupo nunca vira canal do cliente.
6. “Orientar pergunta ao cliente” exige texto claro do operador e envia-o como instrução de pergunta pela mesma continuação do agente; o estado correspondente é “aguardando lead” conforme regra de domínio. A UI deve evitar o rótulo “pedir informação ao cliente” quando dá a entender que o humano vai falar diretamente com o cliente.
7. O bot publica resultado no grupo (quem agiu, ação/status, falha ou conclusão), sem colar conversa completa. A linha do tempo do caso recebe somente mensagem/decisão explicitamente vinculada à ação; conversa lateral dos membros continua só no Telegram.
8. Antes do commit, bloquear corrida com outra resposta humana/IA usando transição atômica/compare-and-set de estado. Um segundo operador recebe “caso já atualizado”, sem turno duplicado.

### 5.4 Interpretação da linguagem natural e replies

- Reply a uma mensagem do bot tem precedência máxima para definir assunto. Salvar a relação entre mensagem Telegram publicada pelo CRM e `case_id`, tipo do cartão e validade.
- Botões e reply são mais confiáveis do que heurística de texto. Botões assinam/identificam ação; mensagem natural apenas inicia confirmação e coleta de texto.
- Texto não marcado pode responder a uma pergunta operacional pendente apenas se remetente está autorizado, a pergunta é recente e a classificação tem confiança suficiente. Para operação mutante, confirmar intenção/alvo antes.
- Não interpretar discussão genérica (“concordo”, “vou ver”, “obrigado”) como ordem de responder/encerrar. Não tratar conteúdo de outro membro desconhecido como autorização.
- Se uma resposta em linguagem natural pode significar “responder ao cliente” ou “registrar informação”, bot pergunta: “Você quer orientar o agente a responder ao cliente sobre este caso?” com botões explícitos.
- Usar LLM para entendimento; decisão de autorização, alvo final, validação de estado e execução é determinística no servidor. Prompt injection presente na discussão do grupo é dado não confiável, não instrução sistêmica.

### 5.5 Novo membro, saída, pareamento e perda de sincronização

- Assinar `chat_member` quando viável; o Telegram exige bot administrador e inclusão explícita de `chat_member` em `allowed_updates` para entregar tais eventos. Configurar `my_chat_member` para mudanças de status do próprio bot e callback queries para botões.
- Registro visto pela primeira vez: gravar participante como `unknown`, suspender IA e escrita de caso do grupo, enviar alerta mínimo e criar tarefa de revisão. Não assumir que o total de membros ou lista de admins representa inventário completo de participantes.
- Administrador do CRM verifica a conta no app/pareamento e associa ao usuário interno, ou operador autorizado aprova/rejeita com callback restrito e auditoria. Aprovação é por Telegram ID e grupo, não pelo @username.
- Aprovar membro pode conceder somente `can_use_assistant`; ações de caso requerem grant separado. Preferência inicial: membro novo só recupera IA após classificação e aprovação completa, evitando que “observador” dispare resposta ou contamine contexto.
- Saída/revogação do vínculo remove grants futuros e invalida callbacks pendentes. Histórico/auditoria permanece segundo retenção.
- Gap de updates, webhook inativo, reset de webhook ou suspeita de sequência perdida define `membership_state=stale/unknown`; fail closed e exige reconciliação. `getChatAdministrators` não é uma lista geral de membros, e Bot API não oferece método genérico para enumerar todos os participantes. A UI deve dizer “membros observados”, não “todos os membros”, a menos que cobertura seja comprovada.

### 5.6 Modo privacidade e limitações do Telegram

O Telegram entrega mensagens diferentes conforme privacidade e estado administrativo. Por padrão, bot em grupo pode receber apenas comandos/replies relevantes; bot administrador ou com privacy mode desligado recebe mais mensagens comuns. Portanto, não prometer IA que acompanha toda conversa sem explicar o acesso necessário. Para responder a texto comum e detectar novos membros de forma confiável, confirmar requisitos diretamente na conexão e mostrar diagnóstico.

Referências oficiais atuais: [Telegram Bot API — Updates, webhooks e membros](https://core.telegram.org/bots/api), [Bot Features — Privacy Mode e bots em grupos](https://core.telegram.org/bots/features), [Bots FAQ — quais mensagens chegam ao bot](https://core.telegram.org/bots/faq). Os requisitos e capacidades devem ser revalidados durante a implementação porque o Telegram evolui sua Bot API.

## 6. Modelo de dados proposto (a fechar após auditoria de constraints)

Não aplicar SQL desta seção sem comparar cadeia completa, baseline, manifesto, RLS, exportação/anonimização LGPD e convenções do repositório.

### 6.1 Grupo e capacidades

Usar a linha `channel_session_groups` como registro de descoberta/allowlist existente e adicionar tabela 1:1 `channel_group_settings` **ou** ampliar `channel_session_groups` se constraints atuais e export/LGPD permitirem sem ambiguidade. Recomenda-se tabela 1:1 para não sobrecarregar `enabled`, mas sem duplicar os dados de identificação. Campos mínimos sugeridos:

```text
id, organization_id, channel_session_group_id UNIQUE,
case_alerts_eligible boolean NOT NULL DEFAULT false,
case_actions_enabled boolean NOT NULL DEFAULT false,
team_assistant_enabled boolean NOT NULL DEFAULT false,
membership_state enum('unknown','healthy','stale','suspended') NOT NULL DEFAULT 'unknown',
membership_checked_at, membership_last_update_id,
assistant_disabled_reason, created_by, updated_by, created_at, updated_at
```

`channel_session_groups.enabled` continua sendo exclusivamente “grupo aparece/recebe mensagem na Inbox humana”. Incluir `connection_id`/provider no caminho da FK composta ou garantir que `channel_session_group_id` só referencia grupo da mesma organização; não confiar em UUID fornecido pelo cliente.

### 6.2 Membros e grants

```text
telegram_group_members:
  organization_id, connection_id, group_chat_id, telegram_user_id TEXT,
  display_name, username nullable, membership_status, first_seen_at,
  last_seen_at, last_update_id, paired_user_id nullable, verified_at,
  UNIQUE(organization_id, connection_id, group_chat_id, telegram_user_id)

telegram_group_member_grants:
  organization_id, member_id, capability
    ('use_assistant','read_cases','act_on_cases','approve_members'),
  granted_by_user_id, granted_at, revoked_by_user_id, revoked_at,
  UNIQUE(member_id, capability) para grants ativos (ou histórico append-only)
```

Avaliar se `telegram_group_members` pode referenciar uma tabela já existente de identidade Telegram criada pelo pareamento. Reutilizar prova e revogação; não duplicar credencial. Nunca persistir token do bot na tabela de participante.

### 6.3 Destino tipado e entrega

Evoluir `config_aviso_de_caso` para destino tipado, preservando os registros WhatsApp legados:

```text
destination_kind ('phone','telegram_group')
channel_session_id / telegram_connection_id conforme destino
destination_group_id nullable FK composta ao grupo/config de mesma org
telefone_destino e destino_jid preservados para kind='phone'
ligado, rotulo, auditoria e guardas atuais preservados
```

Preferir uma coluna `destination_group_id` com FK composta e constraints que permitam destino legado ou Telegram, sem CHECK que quebre `ON DELETE SET NULL`; conservar o trigger de autocura existente. Definir migrations de expansão e compatibilidade antes de tornar novas colunas obrigatórias. A API converte payloads antigos para forma canônica durante uma janela de compatibilidade e mantém leitura de instalações já migradas.

Estender `entregas_de_aviso_de_caso` para chave estável de destino que suporte telefone e grupo (`destination_kind + destination_id`), mantendo unicidade por organização/caso/destino. Guardar `telegram_message_id`, `telegram_chat_id` apenas se necessários à operação, provider outcome/código e tentativas. Não guardar `body` do aviso. Reusar tombstone/retention/LGPD já definido na migration `0292`.

### 6.4 Ações e correlação

Adicionar registro idempotente de interação operacional por `(organization_id, connection_id, update_id)` e, quando aplicável, callback token de uso único. Campos: ator CRM resolvido, grupo, `case_id`, action, message IDs do grupo, status, idempotency key e request/audit ID. Conteúdo textual do operador é armazenado no registro do caso/turno de domínio existente quando necessário; evitar cópia paralela em log.

## 7. APIs, serviços e arquivos envolvidos

Os nomes abaixo são propostas de destino; confirmar padrão real das pastas e contrato de API antes de criar arquivos.

### 7.1 Backend/configuração de grupo

- **Modificar** `app/api/v1/channel-sessions/[id]/groups/route.ts` e seus testes: GET retorna allowlist + capacidades/grupo/membership status; PUT atualiza configurações via schema estrito, `requireRole`, org derivada da sessão, suporte read-only guard, audit e RPC/service transacional.
- **Modificar** `lib/grupos/servico.ts`, `app/app/connections/` grupo drawer/componentes: lista unificada preservando `enabled`; incorporar capacidades e dados do Telegram sem assumir formato de WhatsApp.
- **Criar/adaptar** `lib/grupos/telegram-membership.ts`: aplicar updates de membro, deduplicação, out-of-order/replay, reconciliação e suspensão segura.
- **Criar** `lib/grupos/permissoes.ts`: resolver grants atuais para cada evento/ação com fail-closed; validar membership de organização, papel, identidade pareada e capability da conexão.

### 7.2 Webhook, transporte e worker

- **Modificar** `app/api/v1/webhooks/telegram/[token]/route.ts`: aceitar e classificar `callback_query`, `chat_member`, `my_chat_member`, eventos de join/leave disponíveis; continuar autenticando segredo e deduplicando todo `update_id`.
- **Modificar** `lib/channels/telegram/bot-api.ts`: setWebhook registra `allowed_updates` requerido e reconcilia configuração preexistente sem perder tipos necessários; enviar `sendMessage` com inline keyboard/reply_to, responder callback e editar mensagem se suportado. Cobrir erros/limites do Telegram.
- **Modificar** `app/api/v1/cron/telegram-updates/route.ts` e processador de update existente: roteia update por tipo. `message.group_received` continua não consumidor do pipeline IA normal. Novo evento/runtime interno explícito para `team_group_message` e mudanças de membro/callback.
- **Criar** worker/serviço de avisos de caso Telegram (nome a alinhar ao worker WhatsApp em `0292`): Outbox transacional, retry e idempotência, sem enviar dentro de requisição que abre o caso.
- **Adicionar** driver Telegram em `lib/channels/adapters/telegram.ts` somente através do contrato de envio comum e sem duplicar a política de domínio.

### 7.3 Casos e interação do grupo

- **Criar** `lib/ai/cases/telegram-team-actions.ts` ou serviço de domínio equivalente. Deve reutilizar a transição/turno do fluxo chamado por `app/api/v1/ai/cases/[id]/reply/route.ts`; extrair função de domínio compartilhada dessa rota se necessário, em vez de fazer requisição HTTP interna ou copiar SQL.
- **Modificar** `lib/agent-engine/agent/case-reply-turn.ts` apenas se contrato compartilhado precisar carregar motivo/ator/correlação, mantendo a resolução de conversa do caso (`:71-99`).
- **Modificar** sistema de eventos/avisos que hoje alimenta `config_aviso_de_caso`/`entregas_de_aviso_de_caso`, adicionando o destino Telegram tipado ao mesmo caso de uso.
- **Não modificar** o comportamento global de `fn_request_channel_routing` ou enviar grupos para `message.received`. Criar consumidor/evento isolado e opt-in com testes de que grupo jamais entra em roteador, follow-up, campanha ou atendimento de cliente.

### 7.4 UI

- **Modificar** tela de Conexões, drawer de grupos e hooks de queries/mutations: cartões, grants por membro, alertas, confirmação de exposição e invalidation compartilhada.
- **Modificar** `app/app/ai/cases/avisos/_components/AvisoNoWhatsApp.tsx` e sua página/estado/hooks para “Avisos de casos” e escolha de destino individual ou grupo; migrar mantendo modo WhatsApp.
- **Modificar** `app/api/v1/ai/cases/alerta/route.ts`: GET oferece destinos elegíveis; PUT atualiza apenas destino/estado global no RPC tipado; validar grupo no tenant + ativo + elegível + `team_alerts`.
- **Modificar** testes da página de Avisos, endpoints, migrações, estados de grupo, acessibilidade e traduções `lib/i18n/dicionario.ts`.

## 8. Autorização e segurança obrigatórias

Antes de qualquer consulta ou mutação, exigir interseção de todos os pontos:

1. webhook autêntico e conexão Telegram ativa;
2. update idempotente, ainda não consumido;
3. grupo pertence ao `organization_id` da conexão e está habilitado para aquela capacidade;
4. Telegram user ID pareado e vínculo ativo a usuário CRM;
5. membership ativo na organização e papel CRM atual suficiente;
6. grant daquele usuário no grupo para ação pedida;
7. estado do grupo saudável e nenhum membro desconhecido exigindo suspensão;
8. caso e conversa pertencem à organização; caso está no estado que aceita ação;
9. capability de bot correspondente: `human_cases/read_cases` para leitura e `reply_to_cases` para mutação; `team_alerts/send_alerts` para avisos.

Aplicar controle de repetição e concorrência a comandos, callbacks, texto duplicado, retry do webhook e dois operadores simultâneos. IDs de callback devem ser opacos, tenant-bound, curtos, com expiração e uso único para ações de escrita. Sempre validar permissões novamente na execução; o estado do teclado não é autorização.

Não tornar conversa do grupo disponível ao agente do cliente. Contexto interno contém somente casos e dados mínimos autorizados, não o histórico completo de grupos nem contatos fora do caso. O LLM recebe conteúdo do grupo como material não confiável. Prompt jamais decide escopo/tenant/permissão.

## 9. Auditoria, privacidade e LGPD

- Auditar quem concedeu/revogou grant, aprovou membro, mudou configuração, escolheu destino, consultou dados sensíveis, executou ação de caso e qual resultado foi produzido.
- Logs incluem IDs técnicos e códigos de erro redigidos; nunca token Telegram, código de pareamento, texto completo de cliente, telefone ou `context_snapshot`.
- Mensagem de grupo pode ser vista por todos os membros Telegram. Antes de ativar aviso, mostrar risco e permitir categorias/nível de detalhe configuráveis; padrão é resumo mínimo e link autenticado.
- Casos de canal de cliente podem conter informação pessoal. Destino em grupo só é permitido após confirmação de administrador e aviso de audiência. Avaliar a exposição e acesso externo dos convidados do grupo; permissões CRM não revogam a capacidade dos membros lerem mensagens no Telegram.
- Política de retenção cobre IDs Telegram, usernames observados, eventos de membership, callbacks, entregas e correlação. Exportação/anonimização deve incluir dados atribuíveis e limpar dados pessoais sem destruir obrigação mínima de auditoria.
- Rejeitar grupos cujo estado de membro seja desconhecido se a organização exige proteção por participante. Não apresentar “todos os membros autorizados” com base em `getChatAdministrators`, que retorna administradores e não inventário total do grupo.

## 10. Plano de migrations e instalação self-hosted

1. Auditar migrations posteriores à `0482` e `0708`, `supabase/baseline.sql`, `MANIFEST.md`, constraints e IDs de migration usados em todas as branches. Não reutilizar o número de exemplo desta spec.
2. Rodar verificação de colisão conforme scripts do repo e documentar o próximo identificador livre.
3. Migração aditiva primeiro: tabela/colunas opcionais, índices, FKs compostas, checks e RLS. Dados WhatsApp legados continuam válidos e lidos pelo novo endpoint.
4. Atualizar `baseline.sql` com a definição consolidada, `MANIFEST.md`, enum/checks completos, funções derivadas vigentes, RLS/revokes/grants e triggers, seguindo os invariantes de baseline.
5. Atualizar exportação, cascata LGPD, retenção, testes de migrations e fixtures. Revisar backup/restore e downgrade (feature desligável mesmo que schema permaneça).
6. Aplicar migração local e staging de forma controlada antes de ativar flag; validar instalação existente e instalação limpa pelo baseline.
7. Rollout começa com capacidades desligadas para todos os grupos. Nenhuma instalação perde WhatsApp/Inbox caso não use Telegram.

## 11. Plano de implementação por ondas

### Onda 0 — auditoria e contracts (bloqueante)

- confirmar esquema canônico e constraints do grupo em baseline corrente;
- localizar pairing Telegram atual e reusar identidade verificável;
- mapear worker de avisos WhatsApp e ponto do evento de abertura do caso;
- confirmar adapter de envio de texto/teclado/reply Telegram e semântica de `message_id`;
- confirmar quais canais criam casos e se `case_reply_turn` devolve resposta pelo Zernio em cada provider;
- provar disponibilidade de `chat_member`/`my_chat_member` na hospedagem e efeitos de alterar `allowed_updates`.

### Onda 1 — base de configuração/segurança

Migrations aditivas, grants, sync de membros, endpoints e UI em cartões; sem IA e sem escrita de caso via grupo. Habilitar descoberta/configuração com grupos de teste e banner de membro desconhecido.

### Onda 2 — alertas de caso somente leitura

Destino grupo na tela Avisos, Outbox idempotente, resumo mínimo, monitoramento de entrega, teste de destino e registro de `message_id`. Só ativar para grupos explicitamente confirmados. Confirmar que casos de cada canal chegam ao mesmo destino e sem quebrar aviso WhatsApp individual.

### Onda 3 — consulta e botões para casos

Listar casos, paginação, detalhes mínimos, abrir CRM, callbacks, autorização e auditoria. Não permitir texto livre mutante ainda. Validar caso aberto e fechado, destinatário externo e membro revogado.

### Onda 4 — operações “orientar”

Compartilhar serviço de domínio com UI, integrar confirmação de texto e ação `case_reply_turn`, tratar estados concorrentes, erro de provider e retorno do resultado ao grupo. Validar saída para cada canal origem.

### Onda 5 — assistência natural controlada

**Primeira fatia implementada no checkout WSL:** `team_assistant_enabled` é opt-in e só responde quando um membro humano autorizado faz reply direto a uma mensagem de cartão de caso que o bot publicou. A ativação exige grupo saudável e atestado, capability `human_cases:read_cases` e ao menos um operador ativo do CRM, pareado, revisado, com `can_read_cases` e `can_use_assistant`. O assistente recebe somente título, categoria, estado, resumo e bloqueio sanitizados, mais a pergunta do operador; chama `responderSobreOCaso` com purpose `case_chat`, sem tools nem passos adicionais, sujeito ao orçamento normal. Responde no grupo como reply à pergunta e grava uma interação idempotente e auditada. Falhas de provedor geram mensagem genérica; falha de envio não vira mensagem de Inbox nem aciona o cliente.

Esta fatia é somente leitura: não decide nem executa ações de caso e não envia mensagens ao cliente. Orientar resposta/pergunta continua usando os botões explícitos e o serviço de domínio existente. Mensagens sem reply a cartão de caso continuam sendo discussão humana e não são interpretadas pelo assistente. A expansão futura para contexto sem reply exige confirmação de alvo e avaliação de falsos positivos antes de qualquer escrita.

## 12. Plano de validação e critérios de aceite

### Banco/API/autorização

- tenant A não pode listar, selecionar, editar, avisar ou executar ação em grupo/caso do tenant B;
- campos estranhos, IDs não UUID, ID Telegram truncado, grupo sem conexão e capability ausente são recusados;
- writes não bypassam RPC, RLS, auditoria, MFA/step-up vigente e suporte read-only guard;
- `enabled` legado continua significando exclusivamente allowlist da Inbox;
- toggles em Conexões e seleção em Avisos relêem o mesmo registro e refletem a mudança sem duplicidade;
- alteração de elegibilidade não deixa destino apontando para grupo inativo sem estado de erro visível;
- migration aplicada a instalação existente e baseline reproduzem o mesmo estado.

### Telegram webhook/membership

- deduplicação e updates fora de ordem de `message`, `callback_query`, `chat_member`, `my_chat_member`;
- Telegram user ID e chat ID grandes permanecem intactos;
- privacidade do bot não entrega texto comum: UI sinaliza limitação e IA interna não afirma que leu;
- novo membro suspende automaticamente runtime e avisa; membro aprovado somente ganha o grant escolhido;
- membro não pareado, removido, bloqueado, conta CRM inativa e callback expirado não executam ação;
- webhook indisponível/lag stale suspende escritas; após reconciliar, ações voltam conforme política explícita.

### Avisos

- teste de entrega não cria aviso de caso real;
- um caso gera no máximo uma entrega lógica por destino; retry do mesmo update não duplica mensagem;
- sucesso armazena IDs de mensagem e estado; erro é visível com código acionável;
- mudança de destino e falha de entrega não redirecionam silenciosamente;
- mensagem contém somente resumo aprovado; zero transcript/telefone/context snapshot;
- WhatsApp individual continua funcionando com configuração existente; bot Telegram sem `send_alerts` não é oferecido.

### Casos e interação

- caso de WhatsApp, Telegram e canal Zernio suportado pode ser consultado no mesmo grupo;
- consulta de fechado é somente leitura; mutação de fechado recusada;
- reply ao cartão seleciona caso correto mesmo com vários casos ativos;
- texto ambíguo lista opções; linguagem natural nunca escolhe um caso aleatório;
- transição em corrida retorna conflito sem segundo turno/duplicata;
- `need_lead_info` e `resolved` reutilizam pipeline atual, respondem na conversa original e não no grupo;
- falha do canal de origem não marca entrega ao cliente como sucesso; o grupo recebe status honesto e sem reenvio cego.

### Teste E2E controlado

Em sandbox/grupo de teste e casos sintéticos, com admin ciente dos membros:

1. conectar bot, adicionar ao grupo e validar diagnóstico de permissões;
2. descobrir, ativar avisos e escolher grupo em Avisos; validar sincronização nas duas telas;
3. abrir caso sintético via WhatsApp, Telegram e canal social previamente homologado; confirmar aviso mínimo no mesmo grupo;
4. consultar aberto/fechado, responder com texto de orientação, confirmar caso e resposta no canal original;
5. adicionar membro desconhecido, verificar suspensão/aviso, negar e aprovar membro; confirmar grants distintos;
6. tentar callback de outro usuário, replay, botão expirado, usuário sem grant e caso já resolvido;
7. desconectar bot, perder envio, trocar destino e restaurar; conferir saúde, retry, idempotência e auditoria;
8. verificar que grupo jamais entrou em roteador, campanha, follow-up ou agente de atendimento ao cliente;
9. revisar conversa no grupo para confirmar que discussões não vinculadas não aparecem no histórico do caso.

Critério de liberação: todos os testes de isolamento, autorização, idempotência e comportamento de caso passam; E2E por provider homologado passa; observabilidade identifica qualquer suspensão ou falha. Nenhum canal Zernio entra no anúncio de suporte sem prova de ponta a ponta em staging.

## 13. Matriz de regressão e mitigação

| Área                  | Regressão possível                                                   | Severidade | Mitigação/gate                                                                                    |
| --------------------- | -------------------------------------------------------------------- | ---------: | ------------------------------------------------------------------------------------------------- |
| Pipeline de mensagens | Grupo passa a acionar IA/follow-up/campanha de cliente               |    Crítica | Manter `message.group_received` separado; novo consumidor dedicado; teste de invariantes.         |
| Privacidade           | Resumo do caso visível a membro não autorizado no grupo              |    Crítica | Confirmação de audiência, payload mínimo, controles por grupo, suspensão por membro desconhecido. |
| Autorização           | Nome/@username interpretado como operador CRM                        |    Crítica | Telegram ID pareado + membership/grant atual em cada ação.                                        |
| Confiabilidade        | Avisos duplicados ou caso transicionado sem turno                    |       Alta | Outbox/índice de idempotência, transação estado+enqueue, callbacks one-shot.                      |
| Compatibilidade       | Mudança de `channel_session_groups.enabled` altera grupos existentes |       Alta | Preservar semântica, migração aditiva, fixtures de instalações existentes.                        |
| Avisos atuais         | Endpoint/UI tipados só para telefone param de funcionar              |       Alta | Compatibilidade de payload, migração de dados, testes WA antes/depois.                            |
| Telegram webhook      | Novo `allowed_updates` substitui tipos já necessários                |       Alta | Lista central completa, reconciliação e teste getWebhookInfo; não sobrescrever cegamente.         |
| Membros               | `chat_member` não recebido por falta de admin/update opt-in          |       Alta | Diagnóstico pré-ativação, fail closed e reconciliação; explicar no UI.                            |
| Zernio                | Caso responde em canal errado ou não responde                        |       Alta | Resolver destino pelo `agent_cases.conversation_id`; teste E2E por provider.                      |
| UI/sincronização      | Tela exibe valor antigo ou salva cópia divergente                    | Média/alta | Fonte única, query keys compartilhadas, mutation invalidation e resposta server-authoritative.    |
| LLM                   | Discussão ou prompt injection aciona ferramenta                      |    Crítica | LLM não autoriza; intents mutantes confirmados; grants determinísticos; input não confiável.      |
| LGPD                  | PII em novo registro não incluída em export/cascata/retention        |       Alta | Testes invariantes novos, migration baseline e revisão LGPD dedicada.                             |

## 14. Decisões fechadas e pontos a confirmar antes do código

### Recomendadas como decisões desta spec

- Um destino pode concentrar casos de múltiplos canais; caso guarda sempre o canal original de resposta.
- Discussão do grupo não vira conversa com o cliente nem é copiada para o caso automaticamente.
- Replies a mensagens do bot/caso são a referência mais forte; mensagem sem reply só atua com contexto claro e confirmação para escrita.
- “Responder ao cliente” é nome inadequado para a ação do operador; usar “Orientar resposta ao cliente” e “Orientar pergunta ao cliente”.
- Conexões governa configuração por grupo; Avisos seleciona grupo já elegível e grava o vínculo ao mesmo registro canônico.
- Grupo e IA desligados por padrão. Novo membro/estado de membros desconhecido suspende automação sensível.

### Portas de decisão técnica

1. Reutilização do pareamento de operadores já criado no ciclo Telegram e o schema exato dele.
2. Se configuração canônica será `channel_session_groups` ampliada ou tabela 1:1. Escolher após ler baseline e consumidores LGPD; não manter campos duplicados.
3. Se a primeira versão de Avisos admite simultaneamente WhatsApp individual e grupo Telegram como destinos múltiplos, ou apenas um destino por organização. Recomenda-se preservar o contrato atual de um destino e ampliar explicitamente depois.
4. Quais detalhes do caso/resumo podem ser divulgados no grupo; escolher política default com jurídico/privacidade do produto se aplicável.
5. Suporte Zernio por canal: homologação técnica por Instagram/Facebook antes de prometer o comportamento para todos.
6. Política de membership: sem inventário completo de membros pela API, definir como detectar lacunas e reconciliação manual. Não prometer que o bot sempre consegue listar todos os participantes.

## 15. Checklist de definição de pronto

- [ ] O cartão por grupo deixa claro Inbox, avisos, ações e IA como capacidades diferentes.
- [ ] Conexões e Avisos leem/escrevem a configuração canônica; nenhum campo espelhado controla a mesma opção.
- [ ] Grupos não entram no pipeline normal de IA/follow-up/roteamento.
- [ ] Participantes e casos são tenant-scoped e identificados com Telegram IDs estáveis.
- [ ] Menus/botões consultam estado atual do servidor e não são autorização.
- [ ] Alertas têm idempotência, retry, estado de entrega e resumo mínimo.
- [ ] Ações reusam o domínio e a continuação do caso; resposta segue pelo canal original.
- [ ] Eventos de membro desconhecido, revogação e lacuna suspendem ações conforme policy.
- [ ] Baseline, manifesto, RLS, retenção e LGPD atualizados; instalações existentes testadas.
- [ ] WhatsApp continua compatível; Zernio homologado por canal antes de habilitar.
- [ ] UI apresenta motivo claro para cada estado bloqueado, erro ou capacidade não suportada.

## 16. Registro de validação no ambiente WSL

Data: 2026-10-28. Ambiente: checkout local `codex/telegram`, bot local `@DiskUniformesVendaDev_bot` e grupo privado de QA autorizado (`-5341004870`). Sem deploy na VPS.

### Evidências obtidas

- `pnpm typecheck`: passou.
- Testes focados Telegram: 10 arquivos, 55 testes passaram, abrangendo APIs de conexão/grupo/saúde, Bot API, ingestão, associação de operadores, casos em grupo, handler de avisos e UI de conexões.
- Bateria anterior do mesmo ciclo: 15 arquivos, 81 testes passaram.
- Verificação visual da configuração: aviso de casos e ações habilitados para o grupo de QA; a conta Telegram pareada tem leitura e ação; Inbox do grupo e assistente de IA do grupo permanecem desligados.
- `Verificar webhook`: estado confirmado, zero atualizações pendentes no Telegram e fila de eventos do CRM zerada, com `message`, `edited_message`, `channel_post`, `edited_channel_post`, `callback_query`, `my_chat_member` e `chat_member` na lista de atualizações configuradas.
- Mensagem sintética enviada ao grupo privado de QA: “Teste técnico WSL 2026-10-28: validar recebimento do webhook do grupo QA. Sem caso ou resposta a cliente.” Após o envio, a verificação do webhook continuou sem updates pendentes. Isso é compatível com entrega do webhook; não comprova, por si só, criação de conversa nem resposta de IA, que estão desativadas para o grupo.

### Bloqueios de integração manual

- Playwright não iniciou inicialmente porque `.env.e2e` não existia. O gerador oficial recusou criar o arquivo porque a instância Supabase local não expunha `API_URL`/chaves.
- Supabase CLI identificou a instância local `deskcomm-crm`. A imagem `public.ecr.aws/supabase/kong:2.8.1` não contém `/home/kong/templates/email`, onde os templates de confirmação e recuperação configurados em `supabase/config.toml` tentam ser montados. Após reiniciar a stack preservando os volumes, o CLI continuou sem disponibilizar a API em `127.0.0.1:54321`; a tentativa temporária de iniciar sem os dois `content_path` também falhou no health check da API, então a causa completa ainda não está isolada.
- A configuração original `supabase/config.toml` foi restaurada após a tentativa. A stack foi deixada iniciada com `--exclude kong --ignore-health-check`, preservando o banco e demais serviços locais. Sem Kong, o gerador seguro continua sem obter `API_URL`; não rodei Playwright com `.env.local`, pois este pode apontar para produção.
- Não foi criado caso real/sintético no banco e não houve aviso de caso ao grupo nem clique de ação, para evitar gravar no banco conectado à produção ou usar um caminho que bypassasse o domínio autorizado. Os testes unitários do handler cobrem envio, botões, idempotência, caso já encerrado e destino ausente; falta a prova E2E de persistência e callback no grupo.

### Rodadas de verificação

A contagem de rodadas completas permanece **0 de 3**. A primeira tentativa não é considerada completa: a validação Playwright parou antes de executar por bloqueio de infraestrutura e o fluxo real de aviso/ação de caso não foi exercitado. Reiniciar a contagem somente após corrigir o Kong/API local e executar o checklist E2E com caso sintético isolado, incluindo ação autorizada e confirmação da resposta no canal original.

| Rodada | UI / config | Webhook | Aviso sintético de caso | Ação e resposta no canal de origem | Resultado |
| ------ | ----------- | ------- | ----------------------- | ---------------------------------- | --------- |
| 1 (incompleta) | Configurações inspecionadas; capacidades esperadas ativas | Estado confirmado; update pendente zero após mensagem QA | Não executado — sem E2E isolado | Não executado | Bloqueada pelo Kong local; não conta |
| 2 | Pendente | Pendente | Pendente | Pendente | Pendente |
| 3 | Pendente | Pendente | Pendente | Pendente | Pendente |

### Complemento da validação ao vivo — 2026-10-28

Após corrigir a infraestrutura local, foi criado apenas no banco WSL um caso sintético identificado pela tag `QA Telegram 2026-10-28T13:36:33.178Z 47249ac6` (`e3f8bbb2-468c-4f28-bddf-32d6ae953378`). O gatilho real gravou `ai.case_opened`; o consumidor oficial foi drenado com escopo restrito ao handler de aviso Telegram. Resultado: evento `done`, entrega `sent`, mensagem Telegram `71` no grupo privado `-5341004870` e quatro interações persistidas (`guide_reply`, `guide_question`, `list_open`, `list_closed`). A tela local de Casos abriu o registro em `awaiting_human` com resumo e bloqueio sintéticos visíveis.

A configuração final autorizada pelo usuário permanece no ambiente local: avisos e ações habilitados para esse grupo, membro pareado com `can_read_cases` e `can_act_on_cases`; `team_assistant_enabled=false` e Inbox do grupo desabilitada. Não houve envio de resposta ao cliente. Nenhuma configuração da VPS foi alterada.

O comando `/casos` foi enviado ao grupo e não gerou resposta. Isso é esperado pelo código atual: `handleTelegramHumanCaseUpdate` só processa comandos quando `chat.type === 'private'`; no grupo, a consulta foi registrada como `ignored`. A interface de grupo é pelos botões inline do aviso. O Telegram Desktop exibiu os quatro botões, mas o controle de clique do computador retornou `AXError.failure`, portanto não foi possível validar o clique físico na UI. Para cobrir a ação sem expor outros casos, foi injetado um callback sintético pelo handler real `handleTelegramGroupCaseUpdate`, autenticado com o Telegram ID pareado e ligado a uma interação sintética `guide_question`; somente `answerCallbackQuery` foi simulado. O handler confirmou a interação, registrou Junio como ator e enviou pelo Bot API real a pergunta de orientação ao grupo (mensagem `74`, em resposta ao aviso sintético `71`). Não houve resposta nem envio ao cliente. Esse teste valida handler, autorização, persistência e envio do prompt, mas não substitui um clique real de botão no cliente Telegram.

Verificações executadas neste complemento:

- `pnpm test:unit` para `group-cases.test.ts`, `human-cases.test.ts`, `telegram-case-alert.handler.test.ts` e webhook Telegram: 4 arquivos, 28 testes passaram.
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck`: passou após ampliar o heap do Node.
- Envio real de aviso ao grupo QA: passou; nenhuma mensagem foi enviada ao cliente.

Esta validação cobre uma entrega sintética integrada e a inspeção da página de Casos; não equivale a três ou dez jornadas completas nem a clique real de callback. A revisão automatizada unitária cobre tokens, permissões, idempotência e transições de interação. Registrar novas rodadas completas apenas após observar o callback por clique no Telegram Desktop ou em outro cliente autenticado e validar a resposta até o canal original. A prova por callback sintético não conta como clique manual nem como resposta ponta a ponta ao cliente.

### Fechamento adicional de validação — 2026-10-28

- Suíte completa `pnpm test:unit`: 2.802 arquivos passaram, 1 arquivo foi ignorado e 1 arquivo falhou por timeout de 15 s (`tests/unit/namespace-das-imagens.test.ts`, varredura global). O mesmo arquivo, executado isoladamente, passou com 16/16 testes em 1,40 s. Interpretação: falha não reproduzida isoladamente; manter o resultado global como “1 timeout sob concorrência”, não como suíte verde.
- Teste focado final (6 arquivos): `lib/channels/telegram/group-cases.test.ts`, `human-cases.test.ts`, `group-membership.test.ts`, `lib/escalacao/telegram-case-alert.handler.test.ts`, `app/api/v1/channels/telegram/[id]/groups/route.test.ts`, `app/api/v1/ai/cases/telegram-destination/route.test.ts`: 29/29 testes passaram.
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck`: passou.
- `git diff --check`: passou. A árvore tem apenas esta spec modificada e `evidence/telegram/` não rastreado antes deste complemento; preservar ambos, não incluir arquivos temporários em commit.
- Teste UI automatizado adicional informado como “não encontrou arquivos” usou nomes de caminho incorretos; não conta como execução nem como falha de produto. Os caminhos foram corrigidos na rodada focada acima.
- E2E manual continua incompleto: foi comprovado um aviso sintético real ao grupo e o handler real persistiu/autorizou uma ação de orientação sintética e enviou o prompt ao grupo. O clique de callback no Telegram Desktop não pôde ser acionado por falha de automação (`AXError.failure`); Telegram Web não estava autenticado e exigiria novo login com confirmação externa. Nenhuma resposta foi enviada a cliente. Portanto, rodadas completas: **0/3**.
- Configuração QA mantida conforme autorização: avisos e ações de casos habilitados; IA do grupo e Inbox do grupo desligadas. Nenhuma configuração de produção/VPS foi alterada nesta validação.

### Mapa incremental de conferência — retomada 2026-10-28

Este mapa separa verificações pontuais de uma rodada E2E completa. Um item marcado “verificado” não conta sozinho como rodada. Se qualquer item de fluxo produzir erro funcional, marcar a rodada como reprovada, investigar/corrigir e reiniciar a contagem de rodadas completas em 0/3.

| ID | Item de conferência | Evidência desta retomada | Estado |
| -- | ------------------- | ------------------------ | ------ |
| ENV-01 | A branch WSL ativa é `codex/telegram` | `git branch --show-current`; HEAD `afc22389d1` | Verificado |
| ENV-02 | O Next servido na porta 3000 pertence ao checkout desta branch | `/proc/3399413/cwd` resolve para `/home/junio/projects/deskcommcrm-dev` | Verificado |
| ENV-03 | Serviços locais relevantes estão ativos | Supabase DB/Auth/REST/Kong/Realtime/Storage healthy; worker, Redis e WAHA healthy; app atende e redireciona sem sessão HTTP crua para login | Verificado; acesso CRM confirmado pela sessão CUA |
| CFG-01 | Grupo QA e capacidades persistidas | UI mostra grupo `-5341004870`; avisos=ligado; ações=ligado; Inbox=desligado; IA interna=desligada | Verificado |
| CFG-02 | Autorização do operador no grupo | Junio pareado (`6450629055`), grants de leitura e ação ligados; assistência e aprovação de membros desligadas | Verificado |
| HOOK-01 | Webhook e fila Telegram/CRM | Botão “Verificar webhook”: confirmado; 0 updates Telegram pendentes; 0 CRM na fila; lista inclui `callback_query`, `chat_member`, `my_chat_member`, mensagens e edições | Verificado às 11:11 local |
| HOOK-02 | Mensagem nova de grupo percorre webhook e política de grupo | Mensagem sintética anterior chegou ao grupo; estado de fila zerado após check. Não repetido nesta retomada | Parcial |
| CASE-01 | Caso sintético nasce no WSL e alerta chega ao grupo | Evidência anterior: caso `e3f8bbb2-468c-4f28-bddf-32d6ae953378`, aviso grupo msg 71, quatro botões persistidos | Verificado uma vez; não repetido nesta retomada |
| CASE-02 | Clique real no botão inline Telegram executa callback no CRM | Clique físico tentou-se novamente após screenshot fresco; Telegram Desktop retornou `AXError.failure`, sem mudança visível | Bloqueado pela automação; callback sintético não substitui |
| CASE-03 | Ação de grupo persiste e atualiza o caso pela UI real | Callback sintético pelo handler real enviou prompt ao grupo (msg 74); UI do caso mostra estado sintético. Clique real não validado | Parcial |
| CASE-04 | Resposta orientada continua pelo canal original correto | Não executada. Caso QA tem conversa sintética sem telefone e agente original removido; evitar envio a cliente real | Não verificado |
| E2E-01 | Rodada íntegra inclui UI + webhook + alerta + callback real + confirmação no canal de origem | Há evidência parcial de etapas, mas callback físico e resposta de origem ausentes | Rodadas completas **0/3** |
| AUTO-01 | Typecheck e testes Telegram relacionados | `pnpm typecheck` passou; seis arquivos focados passaram (29 testes); suite completa 2802 pass / 1 skip / 1 timeout, teste isolado do timeout passou 16/16 | Verificado com timeout concorrente documentado |

#### Estado da reconferência em andamento

Nenhum comportamento divergente novo foi observado nos itens de infraestrutura, configuração de grupo ou estado do webhook. A tentativa de clicar no botão real do grupo continuou sem ação; portanto isso permanece limitação de controle da UI e impede concluir o E2E manual. A tela de Conexões também mostra WhatsApp `553499129900` desconectado, estado conhecido e alheio ao Telegram; não alterado nesta reconferência. Nenhuma mensagem de cliente foi enviada e nenhuma configuração da VPS foi alterada.

Próxima evidência necessária para iniciar/fechar rodada 1: operar o botão inline de um aviso sintético em um cliente Telegram autenticado, observar callback processado e a atualização correspondente no CRM; em seguida, validar a continuação no destino de QA de origem. Só então repetir a lista integral para rodadas 2 e 3. Se o caso exigir envio ao cliente, usar exclusivamente uma conversa Telegram de QA com destinatário controlado; não usar destinatário real sem autorização explícita.

### Configuração mantida após autorização — 2026-10-28

O usuário autorizou ativar e manter após o teste os avisos e ações de casos no grupo privado de QA `-5341004870`. A seleção foi salva em **Casos → Avisos** para `DiskUniformesVendasDev_bot · Junio Almeida Vitorino & DiskUniformesVendaDev_bot`. Não se alterou a rota WhatsApp nem qualquer configuração da VPS.

Leitura direta do banco local WSL após salvar confirmou: grupo `healthy`; `case_alerts_enabled=true`; `case_actions_enabled=true`; `team_assistant_enabled=false`; destino canônico `config_aviso_de_caso.destino_tipo='telegram'`, `ligado=true`, apontando para o mesmo grupo; capacidade do bot `team_alerts/send_alerts` ativa. A UI de Conexões confirmou Inbox desligada, grants de leitura e ação apenas para o operador Junio, e sem grant de assistente ou aprovação de membros. O grupo do Telegram mostra dois membros (o operador e o bot); não se inferiu inventário além do estado observado pelo CRM.

A entrega sintética anterior segue persistida como `sent`, mensagem Telegram `71`, com três interações registradas (`guide_reply`, `guide_question` recebida e `guide_question` confirmada). Uma pergunta de orientação foi enviada ao grupo como resposta ao alerta sintético; nenhuma mensagem foi enviada ao cliente.

### Achados de superfície e limites ainda abertos

- A tela **Casos → Avisos** ainda diz “Aviso no WhatsApp” no título principal, mesmo quando o destino canônico selecionado é Telegram; a tela ainda mantém o formulário legado de WhatsApp. Isso é rotulagem/organização inconsistente, não alterei o produto neste ciclo.
- A mesma tela mostrou “Nenhum aviso saiu ainda” enquanto `telegram_case_alert_deliveries` continha a entrega Telegram `sent`. O componente e a consulta atuais leem `entregas_de_aviso_de_caso`, legado do aviso WhatsApp, e não incluem `telegram_case_alert_deliveries`. Assim, o histórico visual não representa as entregas Telegram; a tela pode induzir a equipe a acreditar que nenhum aviso saiu.
- O ambiente WSL continua sem endereço público configurado. O link interno do aviso não é acessível a partir de outros dispositivos; a tela explica essa limitação. Não configurei domínio nem exposição pública.
- Telegram Desktop exibiu as ações inline do aviso, mas a automação CUA não conseguiu clicar nos botões (`AXError.failure`). O handler real foi exercitado por callback sintético com operador autorizado, mas isso não substitui clique real. O comando `/casos@DiskUniformesVendaDev_bot` enviado no grupo resultou `ignored`, comportamento conforme o desenho atual: comandos `/casos` são aceitos em chat privado; no grupo, ações são pelos botões inline e respostas explícitas ao prompt.

A configuração autorizada fica mantida no WSL. A prova de envio do alerta e de autorização/persistência do handler existe; clique físico em botão, abertura do link fora do WSL e resposta ao canal de origem continuam pendentes. Esta evidência não conta como rodada E2E completa; a contagem permanece 0/3.

### Correção do histórico de avisos Telegram — 2026-10-28

Na validação do aviso sintético em WSL, a entrega foi confirmada na tabela `telegram_case_alert_deliveries`, mas a tela **Casos → Avisos** mostrava “Nenhum aviso saiu ainda”, pois sua leitura consultava apenas `entregas_de_aviso_de_caso` (WhatsApp). Corrigi `lib/escalacao/tela-do-aviso.ts` para buscar ambos os históricos com escopo por organização, normalizar os estados Telegram, juntar e ordenar as entregas. Para Telegram a interface mostra somente o nome do grupo; não expõe o ID privado do chat. Para WhatsApp mantém o telefone mascarado. A comparação do laço de retorno agora também considera entregas Telegram.

`app/app/ai/cases/avisos/_components/EntregasDoAviso.tsx` identifica canal e destino. Foram adicionados testes de normalização em `tests/unit/tela-do-aviso-entregas.test.ts` e cobertura de apresentação/mascaramento em `tests/unit/aviso-de-caso-tela.test.tsx`.

Validação após a mudança: `git diff --check` e `pnpm typecheck` passaram; os testes focados de tela, estados de entrega, handler Telegram, casos em grupo e casos humanos passaram (5 arquivos, 45 testes). A instância WSL mostrou a entrega real previamente persistida: “Entregue · Telegram · Junio Almeida Vitorino & DiskUniformesVendaDev_bot”, com link para o caso QA. Não houve envio ao cliente.

A configuração de avisos e ações para o grupo privado QA foi salva e mantida conforme autorização explícita do usuário. Inbox e IA do grupo seguem desligadas. A UI não permite concluir um clique físico do botão inline via automação de acessibilidade (`AXError.failure`); callback sintético já validou o handler e o prompt no grupo, mas não substitui esse clique. Nenhuma das evidências parciais é contada como rodada E2E limpa; o critério permanece **0/3 rodadas completas** até haver clique real e confirmação da continuação pelo canal original em uma conversa de QA controlada.

#### Reteste final após correção da tela — 2026-10-28

- `NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck`: passou.
- `pnpm test:unit tests/unit/aviso-de-caso-tela.test.tsx tests/unit/tela-do-aviso-entregas.test.ts lib/escalacao/telegram-case-alert.handler.test.ts lib/channels/telegram/group-cases.test.ts lib/channels/telegram/human-cases.test.ts`: 5 arquivos, 45 testes passaram.
- `E2E_PORT=3107 pnpm exec playwright test tests/e2e/telegram-conexoes.spec.ts`: 1 teste E2E passou em Chromium. O teste inicia servidor de teste e usa Supabase local; não tocou a VPS.
- Conferência visual em **Casos → Avisos** após atualização: a entrega aparece como “Entregue · Telegram · Junio Almeida Vitorino & DiskUniformesVendaDev_bot” e abre o caso QA. O telefone WhatsApp permanece mascarado; o ID de chat Telegram não aparece.
- O grupo permanece configurado como destino canônico de avisos, ações de caso ligadas, Inbox e assistente desligados, conforme autorização de manter a configuração. Caso sintético continua sem resposta ao cliente.
- Novo clique por coordenada no botão inline do Telegram Desktop retornou falha de acessibilidade, e tentativa de navegação por teclado deixou o foco no campo de composição. A tela não indicou execução do callback. Portanto, botão físico/retorno completo pelo Telegram continua **não comprovado**; rodadas íntegras permanecem 0/3.


#### Multichannel delivery metric - 2026-10-28

The case response-time comparison can have deliveries through WhatsApp and Telegram. The reader now chooses the oldest delivery timestamp across both histories per case, independent of query order. Two tests cover earliest timestamp selection and absent timestamps. The focused suite now totals 47 tests, and typecheck passed after this change. The Telegram connections Playwright test passed (1/1).

### Verification continuation - 2026-10-28

Current checkout confirmation: the WSL repository is on branch codex/telegram at afc22389d1. All changes described below are local to this WSL checkout; no VPS deployment and no commit.

This pass found and fixed a cross-channel measurement defect: when a case had both WhatsApp and Telegram deliveries, the first implementation selected WhatsApp's timestamp based on table iteration order, even when Telegram had been delivered earlier. The pure helper `primeiroEnvioDeAviso` now chooses the earliest actual timestamp per case across both sources. Two unit tests cover cross-channel ordering and missing timestamps. The six focused Telegram/history tests became eight; the complete focused selection is five files and 47 passing tests.

Validation evidence:
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck`: passed after the source helper was added.
- Focused unit command covering alert page, delivery mapping, Telegram alert handler, Telegram group cases, and human cases: 5 files, 47 passed.
- `E2E_PORT=3107 pnpm exec playwright test tests/e2e/telegram-conexoes.spec.ts`: 1 passed. It covers the Telegram connections tab rendering, not case button callbacks. The rendered connections-tab screenshot is `evidence/telegram/conexoes-aba.png`.
- `git diff --check`: passed.
- Browser view in the local CRM displayed the real QA alert as Telegram with the observed group title and no private chat id.
- Bot/group state remains QA-only: case alerts and case actions on, group Inbox and group assistant off, Junio paired with read/action grants. Destination is persisted in the canonical case-alert config. No customer response was sent.
- A fresh Telegram Desktop window state confirmed the actual QA alert and inline buttons. A coordinate click after raising the window again returned AXError.failure; keyboard focus remains in the composer. No callback was generated. A direct synthetic handler callback does not substitute for a real user-interface click.

Incremental item map for next reconfirmations:
| ID | Check | Latest evidence | Status |
| -- | ----- | --------------- | ------ |
| ENV-01 | WSL branch identity | `git branch --show-current` = codex/telegram; HEAD afc22389d1 | Verified |
| CFG-01 | QA group settings persist at intended scope | Local DB and UI: case alerts/actions on; group Inbox/assistant off; canonical alert destination same group | Verified |
| CFG-02 | Operator identity and least privilege | Junio's paired Telegram identity; case read/action grants on; assistant/member approval grants off | Verified |
| HOOK-01 | Telegram webhook health and update types | UI health check previously confirmed; incoming QA group post reached local processing | Previously verified; reconfirm in each clean round |
| ALERT-01 | Synthetic case alert reaches Telegram | Case e3f8bbb2-468c-4f28-bddf-32d6ae953378; delivery sent, Telegram message 71; shown in CRM history | Verified |
| HISTORY-01 | Avisos history includes both channels without leaking ids | Rendered Telegram group title, no chat id; WhatsApp remains masked | Verified; 47 tests |
| METRIC-01 | First-alert response-time calculation merges both channels by earliest timestamp | `primeiroEnvioDeAviso`; tests cover mixed order and null timestamp | Verified |
| CALLBACK-01 | Actual inline Telegram callback triggers authorized action | Two fresh coordinate-click attempts including after raising the window fail at native UI layer; no callback | Blocked on native UI input |
| ACTION-01 | Action changes case through domain flow and returns an explicit prompt to group | Prior synthetic handler exercise persisted interaction and sent prompt 74; real callback not proven | Partial |
| ORIGIN-01 | Human guidance continues on original customer channel without sending to a real customer | QA case has no safe customer destination; no client message sent | Not verified |
| E2E-01 | Three consecutive clean end-to-end rounds across UI, webhook, alert, real callback, and original-channel continuation | New cross-channel defect was found and corrected; real click still unavailable | 0/3; restart only after callback and origin-channel evidence |

The newly found metric defect resets complete-round counting. No clean end-to-end round is claimed. Continue with the remaining integration surfaces, and only begin round 1 after the real callback path and safe original-channel continuation can be observed.

### Verification matrix update - 2026-10-28

Additional automated regression pass:
- Telegram channel CRUD routes, group settings, health route, webhook route, Telegram destination route, Bot API, ingestion, membership, group human cases, and Telegram case-alert handler.
- Cross-channel case-alert destination validation, idempotency, return-loop timing, configuration route, UI rendering, and delivery history.
- Result: 17 test files, 128 tests passed.
- Typecheck and `git diff --check` passed.
- Local Playwright Telegram connections test passed 1/1 in this continuation; it verifies tab/page rendering only.
- Visual review confirms the case-alert history renders the real QA delivery as Telegram with the group title and link. No private chat ID is rendered.

No round is complete yet. During independent review, cross-channel earliest-delivery selection was found incorrect in the first implementation and corrected; this resets the round counter to 0/3. The only live path not automatable here is a physical inline-button interaction in Telegram Desktop: current CUA coordinate attempts fail with AXError.failure and keyboard focus stays in the message composer. Do not count the simulated handler test as a real Telegram callback. Preserve the QA case and current authorized group settings; no outbound client response has been sent.

### Reteste ampliado de interface — 2026-10-28

- A rodada Playwright conjunta de `telegram-conexoes.spec.ts`, `central-avisos-destino.spec.ts` e `central-de-avisos-capacidades.spec.ts` terminou com 4 aprovados e 3 falhas. Como a saída conjunta foi truncada, executei também `E2E_PORT=3107 pnpm exec playwright test tests/e2e/telegram-conexoes.spec.ts` isoladamente: 1 teste passou em 7,5s. Esse E2E cobre apenas renderização da aba Telegram.
- Os dois E2Es da Central de capacidades falharam porque o aviso esperado não estava visível. O cabeçalho do próprio spec documenta a dependência do seed `scripts/seed-e2e-capacidades-ausentes.ts`; não executei o seed sem comprovar que aponta apenas para banco descartável.
- O teste de destinos falhou ao abrir a conversa de fixture porque a mensagem “Mensagem de contexto da Central” não apareceu. Isso precisa de diagnóstico com banco/trace e não pode ser classificado como aprovação.
- A inicialização da aplicação registrou `column system_version.runtime_confirmation does not exist` no banco usado pelo E2E e falhas do Redis que caíram no fallback em memória. A migration `20261025020932_9024_system_runtime_confirmation.sql` existe no checkout, mas a validação atual não provou que o banco do runner a aplicou. Não rodei reset nem migration destrutiva.
- Resultado: os E2Es da Central permanecem vermelhos/inconclusivos; não são evidência de falha do callback Telegram, mas impedem declarar regressão zero. `CALLBACK-01` continua sem clique físico, `ACTION-01` parcial, `ORIGIN-01` não verificado e rodadas limpas **0/3**.


### Continuação da validação local — 2026-10-28

- Corrigi apenas o schema do Supabase local da WSL: a coluna nullable `public.system_version.runtime_confirmation` estava ausente embora a migration `20261025020932_9024_system_runtime_confirmation.sql` já existisse. Apliquei o `ADD COLUMN IF NOT EXISTS` e o comentário da migration; confirmei que a coluna existe. Nenhum reset ou alteração na VPS.
- O E2E de capacidades não era uma regressão funcional: a organização local de testes não tinha conversa para o seed referenciar. Rodei os seeds oficiais `seed-e2e-escalacao.ts` e `seed-e2e-capacidades-ausentes.ts` com `.env.e2e`; ambos anunciaram destino local `127.0.0.1:54321`. Depois, `central-de-avisos-capacidades.spec.ts`: **2/2 passaram**, cobrindo rótulo/motivo do aviso e resolução pela UI.
- Suíte combinada `telegram-conexoes.spec.ts + central-avisos-destino.spec.ts + central-de-avisos-capacidades.spec.ts`: **4 passaram, 3 falharam**. Os dois erros da Central de capacidades foram resolvidos pela preparação de dados descrita acima.
- Reexecução isolada do cenário `agent abre contexto...` em `central-avisos-destino.spec.ts`: continua falhando; a Inbox mostra “Erro ao carregar conversas” e a mensagem de contexto fixture não aparece. A captura de erro registra um toast “Erro interno” e ausência da lista. Ainda precisa identificar qual consulta/rota falha antes de considerar os testes da Central verdes.
- `telegram-conexoes.spec.ts` isolado continua aprovado (**1/1**), mas cobre apenas renderização da aba; não comprova webhook de grupo, callback inline real ou continuação no canal de origem.
- Interface nativa do Telegram: nova tentativa de clique no botão inline “Ver casos abertos” em mensagem do caso sintético retornou `AXError.failure`; a imagem após a tentativa mostra os botões ainda sem resposta. Nenhum callback real foi recebido. A ação continua bloqueada no nível de automação da interface.
- A configuração autorizada do grupo de QA permanece mantida. Nenhuma resposta foi enviada a cliente. A rodada completa permanece **0/3**; não iniciar contagem até concluir callback real e continuação segura pelo canal original, além de deixar os E2Es relevantes sem falhas.
- `git diff --check`: passou. Não houve commit nem publicação.

### Estado atualizado da matriz

| ID | Verificação | Resultado atual |
| -- | -- | -- |
| ENV-01 | Branch WSL | `codex/telegram`, HEAD `afc22389d1`; trabalho local não commitado |
| DB-01 | Schema local `runtime_confirmation` | Migration aditiva aplicada e coluna confirmada |
| E2E-01 | Aba Conexões Telegram | 1/1 aprovado; cobre renderização |
| E2E-02 | Central de capacidades | 2/2 aprovados após semear fixtures locais |
| E2E-03 | Central de destinos / mensagem de conversa | Falha reproduzida; lista de conversas retorna erro e fixture não aparece |
| CALLBACK-01 | Clique real no botão inline do Telegram | Não executado; a camada nativa retorna `AXError.failure` |
| ACTION-01 | Ação autorizada via callback verdadeiro | Parcial; apenas teste sintético anterior, não é equivalente |
| ORIGIN-01 | Continuação pelo canal original em QA controlado | Pendente |
| ROUND-01 | Rodada limpa completa | 0/3 |


#### Correção do schema local e reteste verde — 2026-10-28

A investigação do HAR/trace do E2E de destinos localizou o 500: o banco da WSL estava atrás do código em três colunas usadas nas consultas: `contacts.contact_type`, `organizations.lembrete_caso_ligado` e `system_version.runtime_confirmation`. As migrations correspondentes já estavam no repositório. Apliquei localmente, sem reset, somente as migrations idempotentes `20261024070505_0763_contato_tipo.sql` e `20261024085228_0766_lembretes_de_caso_parado.sql`, além do `ADD COLUMN IF NOT EXISTS` de `20261025020932_9024_system_runtime_confirmation.sql`. A consulta ao catálogo confirmou as três colunas. Nenhuma alteração foi feita na VPS.

Com o seed de teste de capacidades preparado na organização E2E local, a execução conjunta final de `telegram-conexoes.spec.ts`, `central-avisos-destino.spec.ts` e `central-de-avisos-capacidades.spec.ts` terminou em **7/7 aprovados**. O primeiro teste combinado sem o seed adequado falhou nos dois testes de capacidades; essa execução não é a validação final e não indica defeito do produto. O seed de capacidades foi então recriado e a bateria combinada repetida com sucesso.

Também repetidos após as migrations:
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck`: passou.
- Cinco testes unitários focados da tela de avisos, entrega Telegram, handler de alertas, casos do grupo e casos humanos: **47/47 passaram**.
- `git diff --check`: passou.

Limites que seguem: o servidor Redis local não atende e o rate limiter usa fallback em memória; isso não bloqueou estes testes. O clique real no botão inline do Telegram ainda falha na automação nativa com `AXError.failure`; CALLBACK-01 continua pendente. A ação sintética anterior não substitui o clique Telegram, e o teste de continuação pela conversa original ainda depende de uma interação real autorizada/observável. Portanto, o teste automatizado combinado está verde, mas as rodadas completas permanecem **0/3** e a revisão manual real ainda não está certificada.

### Validade das ações de casos e reteste — 2026-10-28

A falha mostrada no Telegram ocorreu porque callbacks de avisos e listas expiravam após 15 minutos. O Telegram mantinha os botões visíveis na mensagem antiga, mas o servidor recusava cliques depois do prazo com “Ação expirada ou indisponível”.

Alterações locais na WSL:
- `lib/escalacao/telegram-case-alert.handler.ts`: callbacks publicados no aviso agora expiram em sete dias.
- `lib/channels/telegram/group-cases.ts`: callbacks de listas de casos abertos/fechados e detalhes também expiram em sete dias.
- Identidade pareada, organização, permissões, capacidades, estado atual do caso e uso único continuam verificados quando cada callback chega.
- Reativei apenas as interações sintéticas `list_open` e `list_closed` da mensagem 71 do grupo QA, por sete dias, para repetir o clique no mesmo botão. Nenhuma ação ou resposta a cliente foi enviada.
- `.changes/telegram-acoes-de-casos-com-validade-maior.md` registra o comportamento.

Verificação:
- Testes focados do handler de avisos e de casos do grupo: 15/15 aprovados.
- Suíte relacionada de Telegram/API/invariantes/interface: 13 arquivos, 76/76 aprovados.
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck`: aprovado.
- E2E `telegram-conexoes.spec.ts`: 1/1 aprovado; cobre somente a renderização da aba.
- O clique nativo via CUA retorna `AXError.failure` e não produz callback. A captura confirma que o card e o botão estão visíveis, mas a camada nativa rejeita o clique por coordenada. A validação do callback real segue pendente.
- A WSL continua sendo o ambiente alvo; sem publicação na VPS e sem commit.
- Rodadas completas E2E continuam em 0/3 até observar callback real e continuação segura pelo canal original.

### Leitura do reteste do botão — 2026-10-28

- A captura com o alerta do Telegram “Ação expirada ou indisponível” corresponde a uma tentativa anterior à renovação local dos callbacks. O webhook recebeu callback às 15:21 UTC; a expiração das ações `list_open` e `list_closed` do aviso QA foi prorrogada às 15:31 UTC.
- Estado posterior no banco local: ambos os callbacks do aviso da mensagem 71 estão `received` e com prazo futuro até 2026-11-04; o grupo continua `healthy`, `case_actions_enabled=true` e conectado à mesma conexão local. Não há atualização de callback após a prorrogação, então o clique ainda não foi validado depois da correção.
- As ações de orientação `guide_reply` e `guide_question` antigas expiraram e não foram reativadas; a interação `guide_question` confirmada também expirou. O reteste solicitado é apenas no botão “Ver casos abertos”, cuja linha de interação continua de uso único.
- A aplicação local segue na WSL em `codex/telegram` (`afc22389d1`), com o serviço de desenvolvimento ativo na porta 3000. O Mac está bloqueado para automação nativa no momento desta conferência; a captura/erro anterior não prova a situação após a renovação.
- Próximo passo de `CALLBACK-01`: desbloquear o Mac e clicar novamente em “Ver casos abertos” na mensagem QA 71; conferir resposta do bot e criação/consumo das interações de detalhe. Até isso ocorrer, nenhuma rodada completa é aprovada; `ROUND-01` permanece 0/3.

### Reteste combinado com fixtures locais — 2026-10-28

A preparação dos dois E2Es da Central de capacidades exige o aviso sintético. Antes da bateria, confirmei que `.env.e2e` aponta tanto a API Supabase (`127.0.0.1:54321`) quanto o Postgres (`127.0.0.1:54322`) para loopback. Executei `scripts/seed-e2e-capacidades-ausentes.ts` com `--env-file=.env.e2e`; o script anunciou `LOCAL` e criou o aviso pelo emissor real. Não houve escrita na VPS.

A suíte combinada foi repetida após o seed:

- `E2E_PORT=3107 pnpm exec playwright test tests/e2e/telegram-conexoes.spec.ts tests/e2e/central-avisos-destino.spec.ts tests/e2e/central-de-avisos-capacidades.spec.ts`: **7/7 passaram** (1 Telegram, 4 destinos e 2 capacidades).
- Os dois testes de capacidades que falharam antes passaram após a fixture exigida ser semeada; a execução anterior sem fixture não é evidência de regressão do produto.
- A tentativa de controle de app nativo ainda encontrou o Mac bloqueado; não foi possível clicar no botão real do Telegram nem observar callback posterior à renovação. Não contar este reteste automático como ronda Telegram completa: `ROUND-01` continua **0/3**.

### Continuação da reconferência visual — 2026-10-28

Estado validado no checkout ativo `/home/junio/projects/deskcommcrm-dev`, branch `codex/telegram`, HEAD `afc22389d1`; `deskcommcrm-dev.service` estava ativo. A UI local permaneceu autenticada e foi revisada sem alterar configurações.

- **Conexões → Telegram:** um bot ativo, webhook confirmado. A verificação ao vivo retornou 0 updates pendentes e 0 itens na fila CRM; recebeu `message`, `edited_message`, `channel_post`, `edited_channel_post`, `callback_query`, `my_chat_member` e `chat_member`.
- **Grupos e comunidades:** um grupo QA observado, `-5341004870`, como destino atual de avisos; reconciliação vigente, 1 participante observado e 0 pendentes de revisão. Avisos e ações de casos ligados; Inbox e assistente interno desligados. Junio aparece pareado e com grants de consulta/ação ligados; grants de assistente/aprovação desligados. A tela informa que o Telegram pode fornecer inventário incompleto de membros.
- **Casos → Avisos:** a entrega sintética do caso `e3f8bbb2-468c-4f28-bddf-32d6ae953378` aparece no histórico como entregue ao grupo Telegram, com link para o caso. A configuração WhatsApp continua sem número conectado e os controles permanecem desabilitados; não foi modificada. A tela alerta que a instalação não tem endereço público, portanto o link interno não abre fora do ambiente local.
- **Testes:** suíte Telegram/API/invariantes/interface — 13 arquivos, 76 testes aprovados; E2Es combinados (conexões Telegram, destinos e capacidades) — 7/7 aprovados após semear a fixture de capacidades com `.env.e2e` local; `typecheck` e `git diff --check` aprovados.
- **CALLBACK-01:** os botões `list_open` e `list_closed` da mensagem Telegram 71 ainda estão válidos até 2026-11-04 e não consumidos. O webhook checker não mostra callback novo depois da renovação. A camada nativa segue inacessível porque o Mac está bloqueado.
- **ROUND-01:** 0/3. Nenhum ciclo conta até observar clique real no Telegram, retorno do bot e continuação segura no canal de origem.

Nenhuma alteração na VPS, envio de mensagem ao cliente, mudança de permissão ou commit foi feito nesta continuação.

### Continuação de validação e estado do clique Telegram — 2026-10-28

O alias SSH `Windows-WSL` confirmou novamente o checkout local `/home/junio/projects/deskcommcrm-dev`, branch `codex/telegram`, HEAD `afc22389d1`. A execução permaneceu na WSL com Supabase local; não houve acesso à VPS nem commit.

- A primeira bateria Playwright combinada falhou em 2 testes de capacidades porque o aviso sintético `capabilities_missing` não existia na organização E2E. Confirmei `.env.e2e` apontando para `127.0.0.1:54321/54322` e executei `scripts/seed-e2e-capacidades-ausentes.ts`, que anunciou escrita LOCAL e criou a fixture pelo emissor de produção. A repetição da mesma bateria passou: **7/7** (conexões Telegram 1, destinos de aviso 4, capacidades 2).
- A seleção unitária ampliada passou: **8 arquivos, 71 testes** cobrindo UI/histórico de aviso, handlers de caso, ingestão, API do bot, membros/grupos e casos humanos.
- `pnpm typecheck`: passou (exit code 0). `git diff --check`: passou.
- Telegram Desktop foi observado com o alerta sintético do caso `e3f8bbb2-468c-4f28-bddf-32d6ae953378` e os botões inline presentes. Um clique por coordenadas em “Ver casos abertos” ainda retorna `AXError.failure`; a captura subsequente mostra a mesma conversa sem resposta nova. Nenhum callback real foi observado. O grupo permanece teste/QA; nenhuma mensagem foi enviada ao cliente.

O bloqueio atual é específico à automação nativa do Telegram Desktop. Os testes locais e o processamento sintético não provam que o callback real funcione na interface Telegram. Itens `CALLBACK-01` e `ORIGIN-01` continuam pendentes; rodadas completas E2E continuam **0/3**. A ausência de fixture na primeira execução foi corrigida e não é classificada como regressão de produto. Nenhuma alteração de configuração, acesso/permissão, VPS ou produção foi feita nesta continuação.

### Tentativa após desbloqueio do Mac — 2026-10-28

- O Telegram Desktop abriu no grupo privado de QA `Junio Almeida Vitorino & DiskUniformesVendaDev_bot`. A mensagem do caso sintético `e3f8bbb2-468c-4f28-bddf-32d6ae953378` mostra os botões inline `Orientar resposta ao cliente`, `Orientar pergunta ao cliente`, `Ver casos abertos` e `Ver casos fechados`.
- A confirmação visual mais recente mostra que `list_open`/`list_closed` da mensagem 71 permanecem dentro da validade de sete dias. Os botões de orientação no mesmo aviso foram criados com validade curta antes da mudança e já não servem para o reteste.
- Tentei clicar em `Ver casos abertos` pela automação CUA no Telegram Desktop. A camada nativa devolveu `AXError.failure`; a captura posterior mostrou a conversa sem alteração e nenhuma resposta/callback novo. Um `Tab` só deixou foco no compositor de mensagem, sem focar os botões inline. Não enviei texto ou comando adicional.
- Permanecem sem confirmação: callback inline real pós-renovação; resposta do bot ao botão válido; percurso subsequente do caso até o canal original. O clique deve ser feito manualmente pelo usuário no botão válido visível e o resultado informado, pois a automação nativa não alcança esse controle.
- Novas mensagens `/casos` e `/casos@DiskUniformesVendasDev_bot` foram vistas na conversa do grupo, mas comandos humanos de caso são aceitos apenas em chat privado com o bot. Para consulta em grupo, o fluxo previsto é usar o botão inline `Ver casos abertos`; esta distinção deve ficar clara na ajuda da interface.
- As configurações QA seguem como autorizadas: avisos e ações ligados; IA de grupo desligada; identidade/grants da conta do usuário conforme já registrado. Nenhuma permissão foi ampliada nesta tentativa; nenhuma ação contra cliente, publicação na VPS ou commit ocorreu.
- Bateria automatizada da continuação anterior permanece válida: 7/7 E2E combinados (após seed local), 71/71 testes focados, 251/251 testes Telegram relacionados, typecheck e `git diff --check` aprovados. Isso não substitui o clique manual nem comprova três rodadas ponta a ponta.
- `CALLBACK-01` segue pendente; `ACTION-01` parcial; `ORIGIN-01` pendente; rodadas limpas completas **0/3**.


### Tentativa de clique após o usuário desbloquear o Mac — 2026-10-28

- O usuário informou que estava desbloqueando o Mac. Após isso, Telegram Desktop foi lido novamente e exibiu o grupo QA e a mensagem sintética do caso com os quatro botões inline.
- Repeti o clique em “Ver casos abertos” por coordenadas. A chamada de interação retornou erro de acessibilidade; a captura posterior mostrou a mesma tela, sem resposta nova do bot nem mudança na mensagem. Navegar com Tab continuou mantendo o foco no compositor, sem alcançar os botões.
- Não aceitei a notificação de entrada do bot como participante, não enviei mensagem adicional e não alterei permissões.
- Portanto, desbloquear o Mac não resolveu o bloqueio da automação de clique. O callback real segue sem confirmação. É necessário que o usuário clique manualmente no botão verde “Ver casos abertos” da mensagem sintética QA; depois conferir a resposta do bot e os registros do callback no banco local. Não usar o aviso de caso antigo nem os botões “Orientar...” expirados.
- A suíte unitária completa `pnpm test:unit --reporter=dot` está em execução na WSL; não há resultado final disponível ainda. Registrar o resumo quando o processo terminar. `git diff --check` passou na verificação anterior.


### Resultado da suíte unitária completa — 2026-10-28

- Na WSL/branch `codex/telegram`, `pnpm test:unit --reporter=dot` concluiu em 606,79s. Resultado: **29.968 testes passaram, 1 esperado falho, 1 ignorado; 2.803 arquivos passaram, 1 falhou e 1 foi ignorado**.
- A única falha foi `tests/unit/namespace-das-imagens.test.ts`, teste “o literal do namespace só aparece nos arquivos permitidos”, timeout de 15s. É uma cerca ampla de arquivos e não está relacionada ao Telegram.
- Reexecutei o arquivo isoladamente: **16/16 passaram em 6,37s**. Evidência consistente com contenção/timeout da suíte integral, não falha reproduzível do teste.
- A suíte completa teve resultado não totalmente verde por causa do timeout; a repetição isolada passou. Os testes focados de Telegram e o E2E combinado local já registrados permanecem verdes.
- Depois de o usuário informar que iria desbloquear o Mac, conferi novamente o Telegram Desktop. A mensagem sintética e o botão “Ver casos abertos” permanecem na tela, sem nova resposta do bot. A tentativa automatizada continua retornando erro de acessibilidade; aguarda-se o clique manual e o resultado informado pelo usuário.
- Estado de aceite inalterado: callback Telegram real pós-renovação não confirmado; ação e continuação pelo canal original ainda não passaram como fluxo manual; **ROUND-01 0/3**.
- Nenhum deploy, commit, escrita na VPS ou mudança de permissões foi feito.
