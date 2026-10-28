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
