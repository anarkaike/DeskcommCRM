# Telegram como plataforma de canais, apps e operações

> **Status:** proposta inicial para descoberta e revisão do produto; ainda não aprovada para implementação.
> **Base lida:** `product/main` em `e36bfc9e8a54e5d9a2596d69f10f1725f7694be0` (inclui o merge do PR #3010).
> **Objetivo:** planejar uma integração Telegram nativa, extensível e multi-tenant, com vários bots independentes e experiências/app capabilities conectáveis a diferentes partes do CRM.

## Resumo para decisão

O DeskcommCRM deve tratar Telegram como um conjunto de integrações relacionadas, cada qual ativada e autorizada separadamente:

1. **Bot connection:** credencial e identidade de um bot da Bot API. Uma organização pode conectar vários bots, cada um com sua saúde, uso, políticas, roteamento e destino.
2. **Telegram app capability:** recurso associado a um bot, como atendimento por mensagens, Mini App, Telegram Business, Login ou pagamentos. Não presumir que “app” seja sinônimo de bot ou de um único canal; a plataforma Telegram permite que um único bot ofereça várias Mini Apps nomeadas por `short_name`, então o Deskcomm deve permitir apps independentes sob o mesmo bot quando fizer sentido.
3. **Placement/binding:** associação explícita entre uma conexão/capacidade e uma função do produto: inbox, agente, canal de aviso, caso humano, portal do cliente, ferramenta de agente ou operações da plataforma.

Isso permite cenários como um bot de atendimento ao cliente, outro de alertas internos e um terceiro para administração, sem obrigar o tenant a ligar todos os usos ao mesmo bot. O plano propõe a capacidade de conectar bots trazidos pelo próprio tenant como primeiro caminho. Um bot operado pelo dono da instalação para a plataforma deve ficar em um domínio separado, nunca ser um atalho para acessar dados de tenants.

**Não significa dar “permissões totais” ao modelo por Telegram.** A interface conversacional pode solicitar operações, mas o servidor continua aplicando o RBAC existente, escopo do tenant, papel, auditoria e confirmação. Para superadmin, o escopo de plataforma exige autorização e ferramentas próprias, allowlist de operadores e aprovação adicional para atos destrutivos ou que afetem tenant.

### Escopo da conexão e identidade de quem usa

Propriedade da integração e identidade/autorização da pessoa são coisas distintas:

- **Bot de tenant:** a conexão pertence ao `organization_id`, não ao usuário que digitou o token. Um manager autorizado configura e administra a conexão; sair da organização ou perder o papel não transfere nem mantém propriedade pessoal do bot. Destinos, bindings e dados permanecem no escopo do tenant.
- **Bot de operações da plataforma:** a conexão pertence ao escopo da instalação/plataforma e fica separada das conexões dos tenants. O Telegram ID de cada operador é pareado a uma conta de usuário DeskcommCRM; o servidor verifica estado do pareamento, `platform_admin` e autorização para a ação em cada update. O operador é a identidade que age; não é dono pessoal do bot nem recebe poderes apenas por conversar com ele.
- **Vínculos pessoais:** quando a função é inerentemente do usuário — por exemplo, preferências de aviso, login/vínculo de conta ou uma autorização Telegram Business delegada — registrar o grant no usuário apropriado, com tenant e finalidade quando aplicável. Isso não transforma o token de um bot compartilhado em credencial pessoal.

Assim, “Telegram do superadmin” é pelo **usuário para autenticar e autorizar quem está falando**, mas o **bot/conexão de gestão é da plataforma**. O vínculo precisa ser explícito, revogável e auditável; username e nome de exibição não identificam o operador. A conexão de plataforma também não ganha acesso cross-tenant por padrão: cada operação precisa nomear e validar o tenant-alvo e registrar esse escopo.

### Autoria, autenticação e execução de cada ação

Toda ação iniciada por uma mensagem deve ter um **ator autenticado** antes de produzir efeito no CRM. O update autenticado pelo webhook identifica a origem Telegram (`connection_id`, Telegram user ID, chat e contexto), mas esse identificador sozinho não concede permissão. A autorização deve resolver uma identidade DeskcommCRM ativa e avaliar a ação, o escopo e os grants atuais a cada solicitação.

- **Ação administrativa ou de operador:** sempre vinculada a um usuário DeskcommCRM pareado e elegível. Comandos, consultas e confirmações ficam auditados em nome desse usuário. Para operações de maior risco, exigir confirmação recente e/ou step-up na interface web/MFA; estar numa conversa autorizada não é confirmação universal.
- **Ação de cliente/paciente ou contato externo:** não exige criar uma conta interna para cada remetente. O Telegram ID precisa ser vinculado por fluxo verificável ao contato apropriado; só habilita jornadas e dados explicitamente permitidos para aquele contato/tenant. Um contato externo nunca herda permissões administrativas.
- **Execução por agente, automação ou fila:** registrar separadamente o ator que iniciou/consentiu, o agente ou principal de serviço que executou, o tenant-alvo, a política/grant usado e o resultado. Um agente não substitui a autenticação do ator nem amplia o escopo recebido.

Vínculo ausente, revogado, ambíguo ou fora do escopo resulta em recusa segura e instrução para concluir o vínculo pelo fluxo apropriado. Nenhum efeito colateral administrativo é autorizado somente porque a mensagem veio do bot correto ou de um Telegram ID previamente observado.

### Resolver sempre a pessoa, sem confundir contato com login

A filosofia do produto deve ser: **toda interação tenta resolver quem é a pessoa dentro do DeskcommCRM antes do roteamento funcional**. Isso pede um seam de resolução de identidade/canal que entregue um contexto de ator tipado, ou um resultado explícito `unresolved`; não deve ficar escondido como uma instrução no prompt do agente.

O primeiro levantamento aponta dois conceitos que o CRM já trata separadamente e que precisam continuar distintos: `contacts` é a pessoa física no Customer 360 e no escopo de uma organização (`docs/specs/02-spec-customer-360.md`); `auth.users` + `user_organizations` representa login, membership e papel de quem trabalha na organização (`docs/specs/01-spec-platform-base.md`). Assim, uma mesma mensagem pode resolver para:

- **Membro da empresa:** identidade Telegram vinculada por prova a um usuário autenticado, com membership ativo na organização. Funções operacionais/administrativas vêm do papel e das políticas atuais, nunca de nome, username ou configuração do agente.
- **Cliente/lead/paciente:** identidade Telegram vinculada por prova ao `contact` correto do tenant. O contato é reconhecido no CRM sem criar automaticamente uma conta interna; qualquer acesso autenticado a portal/Mini App pode ter uma credencial própria, ligada ao contato e limitada às suas jornadas/dados.
- **Operador da plataforma:** identidade Telegram vinculada a usuário elegível com autoridade de plataforma, separada de membership tenant e revalidada para cada ação cross-tenant.
- **Desconhecido ou ambíguo:** não executar ações privadas ou mutantes; oferecer o fluxo de identificação/vinculação apropriado e, quando previsto, encaminhar para atendimento humano.

O vínculo deve considerar tenant, conexão/bot e identificador remoto estável; username, nome e telefone alegado não são chaves globais suficientes. A confirmação pode usar sessão já autenticada no DeskcommCRM, link de uso único, OTP ou Mini App com prova validada, conforme risco. Resolver uma pessoa não equivale a autorizar qualquer ação: identidade, autenticação da sessão, membership/relacionamento, permissão da operação e consentimento continuam sendo verificações separadas.

### Telegram ID, chat e permissão são registros diferentes

Não guardar um `chat_id` solto no perfil nem permitir que a configuração do bot atribua `admin` ou `superadmin`. No update do Telegram, `from.id` identifica o usuário que enviou a mensagem; `chat.id` identifica a conversa/destino. Em grupo, várias pessoas compartilham o `chat.id`, então ele nunca pode ser usado para decidir quem é o ator. Persistir IDs como texto/inteiro de 64 bits, sem truncamento por tipos de 32 bits.

O perfil do DeskcommCRM pode mostrar que a conta Telegram está vinculada, mas a fonte de dados deve ser uma relação própria de identidade externa, verificável e revogável, ligada ao usuário autenticado (ou ao contato externo, sem criar login). Essa relação não concede permissões. O CRM também mantém separadamente os chats/destinos conhecidos de cada conexão, para resposta e avisos; descobrir um `chat.id` por uma mensagem não prova que aquele Telegram pertence a um usuário interno.

Para cada update, calcular autorização no servidor como a interseção de: (a) vínculo Telegram comprovado e ativo, (b) membership e papel atuais do usuário no tenant — ou papel de plataforma para o bot administrativo —, (c) escopos habilitados para aquela conexão/superfície e (d) permissão específica da ação, incluindo confirmação quando exigida. O bot pode restringir onde um usuário atua, nunca elevar o papel dele. Mudança de papel, saída do tenant ou revogação do vínculo passa a valer na próxima ação.

O fluxo de pareamento recomendado começa com o usuário já autenticado no DeskcommCRM: gerar desafio curto, de uso único, provar a posse pela conversa com o bot e confirmar a associação no CRM. Para administração da plataforma, aceitar somente usuários que já tenham `platform_admin` e pareamento explícito; o modal da conexão configura escopos operacionais permitidos, não concede esse papel. Para clientes/pacientes, vincular ao `contact` por jornada de prova e limitar a experiência a esse contato.

Essa responsabilidade é de um contrato/domínio compartilhado de identidade de canal e resolução de ator (a forma e o schema serão confirmados na Onda 0), com adapters fornecendo identificadores de origem e features consumindo o contexto resolvido. Não pertence à configuração de follow-up nem ao prompt/configuração do agente: follow-up agenda e retoma trabalho; agente escolhe comportamento e ferramentas permitidas. Ambos recebem o ator original e seu contexto para preservar auditoria e não elevar privilégio durante a continuidade.

## O que existe no código hoje

- `lib/channels/types.ts` define os providers de mensagem e o contrato de adapter; a lista atual não inclui Telegram.
- `lib/channels/capabilities.ts` é a única matriz que descreve diferenças entre canais. Recursos só devem aparecer como capability quando têm consumidores reais.
- `lib/channels/inbound.ts` resolve sessões, valida assinatura e despacha webhooks para ingestion. A rota genérica existente é `app/api/v1/webhooks/channel/[token]/route.ts`.
- `channel_sessions` já é tenant-scoped e tem token de path, segredo cifrado, status, saúde e metadata. O contrato atual também carrega pressupostos de WAHA (`waha_session_name`, número, warm-up), portanto não se deve assumir que basta inserir uma linha Telegram sem revisar os invariantes e constraints.
- `app/app/connections/` é a superfície de conexão por organização; `app/app/inbox/` e `app/app/inbox/[id]/` são o atendimento humano; `app/app/ai/cases/` e `/avisos/` cobrem casos e alertas; agentes e MCP ficam em `app/app/ai/agents/`, `lib/agent-engine/` e `lib/mcp/`.
- Há destinos para preferências de notificações, campanhas, automações e integrações em `app/app/settings/notifications/`, `app/app/campaigns/`, `app/app/settings/automacoes/` e `app/app/integrations/`.
- A área de plataforma já usa `requirePlatformAdmin` em `app/admin/(protected)/` e tem páginas de tenants, incidentes, auditoria, configurações e inbox administrativa.
- Telegram só aparece hoje em `lib/channels/social/catalog.ts` como rede social com `inbox: false`, e em testes do seam que documentam que ainda não é provider de conversa.

Esta leitura é uma fotografia do commit indicado; os detalhes de tabelas, roteamento, UI e contratos deverão ser revalidados no início de cada etapa de implementação.

## Nortes arquiteturais que a feature deve preservar e expandir

O objetivo é estender os bons contratos do projeto, não contorná-los para entregar uma primeira demonstração. O norte já escrito em `docs/doctrine/restricao-de-canal.md` é: features descrevem capacidades e políticas, enquanto a fronteira de canal traduz protocolos e nomes de provider. A regra prática é expandir um seam quando ele representa uma diferença real e tem consumidores claros; não criar uma camada genérica vazia só porque Telegram tem muitas APIs.

### Fronteiras que devem continuar claras

1. **Provider edge (`lib/channels/`):** token, URL, assinatura de webhook, payload, IDs remotos, erros e limites próprios do Telegram ficam nessa fronteira. UI de inbox, agente, casos, campanhas e notificações não pergunta se a conversa é Telegram.
2. **Domínio comum:** contatos, conversas, mensagens, casos, eventos, fila, autorização e auditoria continuam sendo as peças centrais. A conexão/bot de origem acompanha a conversa para resposta e rastreio, sem duplicar inbox ou criar um CRM paralelo.
3. **Política de envio:** o runtime pede o efeito desejado; regras de horário, elegibilidade/consentimento, limites, opt-out, orçamento, handoff e guardrails continuam fora do adapter, seguindo a doutrina. Uma recusa ou não aplicabilidade precisa deixar razão visível/traceável.
4. **Bindings de uso:** conectar um bot não o associa implicitamente a toda feature. O tenant escolhe, por bot/app, quais agentes, destinos, alertas, casos, ferramentas ou Mini Apps estão ligados.
5. **Operação self-host:** credenciais BYO e valores opcionais por instalação/tenant, guardados no servidor; nenhuma instalação sem Telegram perde os demais canais, nem depende de uma conta central obrigatória.

### Cobrir o ciclo completo, não só `send()`

O adapter atual é forte na borda de envio. O ciclo Telegram precisa de contratos coerentes — separados por responsabilidade, ainda que compartilhem um registro — para:

- **Conexão e lifecycle:** validar credencial, descobrir identidade do bot, configurar/remover webhook, testar ida e volta, pausar, reconectar/rotacionar e reportar saúde. Toda configuração tem tela, leitura, mudança e falha visível.
- **Entrada:** autenticar e decodificar update em envelope neutro versionado (origem/bot, update id, chat/user/thread, horário, tipo e payload semântico). Inbound, status de entrega, callback de botão, membership e eventos de Business não devem ser confundidos como mensagens de texto.
- **Saída:** endereçar pelo destino remoto correto e oferecer capacidades tipadas para texto, mídia, reply/thread, teclado/callback, edição, remoção e presença conforme suportado. Idempotência, resultado de entrega e erro seguem contratos comuns.
- **Identidade e destino:** mapear o Telegram user/chat/topic para identificador de canal opaco; não fingir que é telefone. A união com um contato/lead do CRM é uma operação própria, verificável, consentida e auditada.
- **Capacidades:** compor três fontes sem confundi-las: (a) limites intrínsecos do protocolo/provider, (b) direitos realmente concedidos nesta conexão (especialmente Telegram Business) e (c) módulos/feature flags habilitados na instalação. O comportamento efetivo falha fechado quando um direito está ausente ou desconhecido.
- **Persistência, eventos e privacidade:** usar os registros compartilhados onde os invariantes de fato couberem; arquivar/reter/reprocessar com idempotência; incluir IDs de bot/chat no contrato de LGPD sem vazar token nem conteúdo no audit.

### Abstrações a aperfeiçoar com evidência

Antes de implementar, a Onda 0 deve produzir um inventário dos consumidores e responder:

1. Quais responsabilidades hoje estão em `ChannelAdapter`, quais ficam em `lib/channels/inbound.ts` e rotas, e quais são apenas configuração/UI. Registrar a fronteira de cada uma em vez de chamar tudo de “adapter”.
2. Como o adapter de aplicação e o adapter interno do agent-engine se relacionam. Eles têm contratos e objetivos diferentes; a implementação deve nomeá-los e documentá-los sem duplicar a seleção de provider nem deixar o runtime com capabilities erradas para o canal da conversa.
3. Qual é o envelope mínimo neutro para entrada e saída que serve aos canais atuais sem apagar suas semânticas. Não converter eventos sociais, callbacks, mensagens de voz e estado de entrega em `text` genérico.
4. Se a matriz atual de capabilities precisa de dimensões adicionais ou de uma camada de grants por conexão. Cada campo novo terá pelo menos um consumidor real e teste de paridade entre todos providers; limites de natureza distinta continuam separados.
5. Quais invariantes de `channel_sessions`, colunas por provider, constraints, FKs e leituras sem filtro bloqueiam um bot sem número de telefone ou sessão WAHA. Decidir entre expandir esse núcleo ou criar um registro de conexão relacionado sem duplicar `conversations`/`messages`; documentar migração e compatibilidade com instalações self-host existentes.
6. Onde o seam compartilhado de resolução de identidade de canal deve viver: mapear os resolvers atuais de contato por telefone/ID externo, membership e vínculo de login; definir como retornam `member`, `external_contact`, `platform_operator` ou `unresolved`, preservando isolamento por tenant e prova de vínculo.
7. Se login, Mini Apps, Business e pagamentos são adapters do canal ou integrações/capabilities paralelas. Só o transporte que envia/recebe mensagens participa do adapter de messaging; login/OIDC, Mini App e pagamento mantêm seus contratos de identidade, autenticação e dinheiro.

### Regra para decidir se um contrato entra no núcleo

- Entra no núcleo quando representa conceito durável e compartilhado (connection identity, tenant scope, normalized update, capability/proof, message delivery outcome, audit correlation) e tem ao menos dois consumidores reais.
- Fica no provider quando descreve formato, endpoint, assinatura, ID, erro ou limite específico.
- Fica na feature quando descreve objetivo de negócio (abrir caso, avisar pessoa, responder lead) sem conhecer o provider.
- Usa capability tipada quando o recurso varia por canal/conexão; não usa `if provider`, casts silenciosos, `unknown as`, nem capability `true` só para compilar.
- Se um recurso não é suportado, o contrato declara `unsupported/not_applicable` com motivo observável. Não simula sucesso e não cai para WAHA ou outro bot.

### Definition of done arquitetural da Onda Telegram

Além do DoD normal do repositório, uma contribuição só fecha quando:

- existe um provider independente e um registro explícito (nenhum nome Telegram fora da fronteira apropriada);
- um conjunto de conformidade comum exerce conexão, tenant isolation, idempotência de entrada, entrega/erro de saída, eventos duplicados, revogação e saúde para cada adapter;
- capabilities, grants da conexão e autorização do usuário são comprovados separadamente;
- o caminho Inbox/IA/casos/avisos usa os contratos comuns sem detectar Telegram em feature code;
- o mapa `docs/architecture/` tem pelo menos duas arestas reais e a Living System Checklist nomeia entrada, saída, tela, navegação, observabilidade, mecanismo anti-morte e laço de retorno;
- a instalação limpa e a upgrade self-host funcionam sem Telegram configurado; migrations e baseline preservam canais que já existem;
- a prova de interface demonstra configuração e uso real dos vários bots, incluindo uma falha reproduzível e como o operador a corrige.

## Mapa de oportunidades por superfície

| Área do produto | Uso Telegram possível | Destinatário e valor | Limite que o desenho deve respeitar |
|---|---|---|---|
| **Conexões do tenant** | Cadastrar vários bots; identificar @username; testar token; escolher o que cada bot pode fazer; ver webhook, último evento, erro e saúde; pausar, renovar ou revogar segredo | Administrador do tenant mantém bot de suporte, de vendas, de avisos ou de operação separados | Token cifrado no servidor, nunca devolvido ao browser ou a logs; cada ação escopada à organização |
| **Inbox unificada** | Receber/enviar texto e mídia, editar status quando suportado, responder a mensagens citadas e distinguir usuário, grupo, tópico e chat privado | Atendentes trabalham nas conversas junto aos demais canais | Identidade por `(tenant, bot, chat)`; capabilities declaram diferenças. Grupos e tópicos são opt-in e não acionam IA/campanha por acidente |
| **Identidade e CRM 360** | Vincular Telegram user/chat a contato e lead; link de início com referência de campanha; unificar com e-mail/telefone apenas por consentimento ou dado confirmado | Cliente/paciente/lead é reconhecido entre canais | ID do Telegram é identidade de canal, não prova de telefone ou consentimento; conflitos e mesclas ficam auditados |
| **Agentes conversacionais** | Selecionar quais agentes atendem em cada bot/chat; configurar idioma, horário, knowledge base, handoff e limites por destino; responder com botões/comandos | Atendimento e qualificação sem misturar marcas ou públicos | Mesmo runtime e guardrails do agente; política de elegibilidade e opt-out; teto de custo, pausa e fallback humano |
| **Casos humanos / retaguarda** | Criar e atualizar casos por bot interno; avisar responsável; permitir respostas estruturadas como concluído/precisa de contexto/escalar | Equipe resolve tarefas sem assumir a conversa do cliente quando não precisa | Bot interno e bot público têm bindings explícitos; comando exige identidade do operador verificada e caso no tenant correto |
| **Avisos e respostas a avisos** | Enviar alertas de caso, agenda, falha de integração e fila; botões para abrir, reconhecer, adiar ou encaminhar; respostas alimentam o sistema | Equipe atua rapidamente pelo Telegram | Preferências por categoria/destino; deduplicação, rate limit, expiração e registro de entrega; nenhuma ação mutante por callback sem revalidar permissões |
| **Ferramentas de agentes / MCP** | Ferramentas para consultar estado e iniciar ações Telegram; receber contexto do chat Telegram; acionar o CRM a partir de chat ou comando | Operadores e agentes usam recursos contextuais | Tools existentes do CRM continuam sendo a fonte de autorização. Ferramenta nova recebe credencial e binding específicos, não token arbitrário nem acesso cross-tenant |
| **Automação e workflow** | Gatilhos por comandos, mensagens, botão, pagamento ou status; enviar notificações e coletar confirmações; encaminhar evento externo via webhook | Orquestrar rotinas de suporte, vendas e operação | Opt-in, controle de loops, idempotência, limite de volume e preview; não transformar uma mensagem em autorização permanente |
| **Campanhas e comunicação proativa** | Enviar conteúdo segmentado, lembretes, novidades e mensagens de retenção pelo bot escolhido | Alcance de clientes inscritos no bot | Requer consentimento/base elegível e suporte a `/stop`; o Deskcomm não deve prometer envio frio. Preferência e opt-out vinculados ao bot e ao tenant |
| **Mini App / portal do cliente** | Mini App para abrir chamado, acompanhar caso/pedido, marcar horário, preencher dados, aprovar proposta, atualizar consentimento, enviar documento ou acessar FAQ | Experiência autenticada dentro do Telegram para clientes/pacientes/lojistas | `initData` validado no servidor e com validade; permissões por operação; não confiar em `initDataUnsafe`; URL/origem e associação da Mini App configuradas explicitamente |
| **Agenda e tarefas** | Consultar compromissos, confirmar/cancelar, pedir remarcação, receber lembretes e coletar dados antes da consulta | Clínicas e negócios de serviço reduzem faltas e atrito | Reusar regras e autorização da agenda; confirmação explícita e regras locais de horário; evitar expor dados sensíveis em grupos/notificações |
| **Pedidos, pagamentos e Nuvemshop** | Consultar pedido, enviar link de acompanhamento, confirmar status e conduzir checkout quando integração de pagamento for planejada | Comércio atende e converte dentro do Telegram | Não guardar cartão nem marcar venda paga por retorno do cliente; webhook/recibo do provedor é fonte de verdade; pagamento entra em fase própria |
| **Comunidades, grupos e canais** | Bot de moderação/triagem, captura de pedidos, encaminhamento para caso, respostas em tópicos e avisos em canal | Marcas e comunidades centralizam suporte e relacionamento | Instalação/escopo em cada chat escolhido; permissões administrativas mínimas; proteção contra loops e injeção de conteúdo; comportamento de IA em grupo desligado por padrão |
| **Login e identidade** | Entrar no portal web, vincular conta, pedir dados de perfil/telefone com consentimento e habilitar mensagens diretas | Reduz fricção no acesso ao portal/Mini App | Login Telegram não eleva papel nem substitui Auth/MFA; validar OIDC/assinaturas, `state`, nonce, audience e escopos no servidor |
| **Superadmin da instalação** | Bot separado para consultar saúde, fila, incidentes, uso e estado de integrações; receber alertas; abrir links para Console; executar ações nomeadas aprovadas | Dono da instalação opera o DeskcommCRM em trânsito | Identidade superadmin confirmada por allowlist + pareamento seguro no Console; escopo de plataforma separado de organizações; leitura primeiro; toda escrita com auditoria e confirmação de alvo |
| **Suporte da plataforma por tenant** | Em contexto de tenant, coletar diagnóstico, alertar dono, abrir sessão de suporte ou pedir aceite para ação assistida | Suporte da instalação acompanha problemas de organizações | Sem assumir tenant pelo Telegram ID. Suporte temporário, propósito limitado, consentimento quando exigido, trilha de início/fim e `support_readonly` respeitado |
| **Observabilidade e operação** | Alertar conexão caída, webhook inválido, limite de envio, fila travada, token revogado; painel de taxa de entrega/erro e reprocessamento | Administrador do tenant e superadmin detectam falhas | Alertas não contêm token, conteúdo de mensagem ou PII desnecessária; reprocessamento idempotente, ações reversíveis e trilha de auditoria |
| **Onboarding, documentação e teste** | Gerar instruções de BotFather, link `/start`, mensagem de prova, comandos e checklist de permissões; ambiente de teste por conexão | Usuário configura a integração sem editar servidor | Não pedir segredo em chat nem deixar token em URL; não marcar saudável com base somente em HTTP 200: provar ida/volta por bot e chat de teste |

## Conceitos de configuração propostos

Estes nomes são conceituais, não são uma decisão de schema:

- **Bot connection:** `organization_id`, Telegram bot id/username, apelido local, token cifrado, modo de recepção, secret de webhook, estado, último update, erro resumido e marca de revogação. Segredo e `file_id` não entram em audit/logs.
- **Capability/app:** uma declaração de qual recurso Telegram foi configurado (Bot API, Mini App, Business connection, Login/OIDC, payments, comunidades). Um bot pode ter várias Mini Apps, cada uma com `short_name`, URL, objetivo e bindings próprios. Cada capability tem seu próprio estado, chave/credenciais, permissões e validação.
- **Placement/binding:** associação da capability ou bot a um uso do Deskcomm (atendimento, agente, alertas, casos, Mini App de cliente, ferramenta, ou operações de plataforma), com rota/destino, agente, política, grupos/chat allowlist e regras de prioridade.
- **Destinos Telegram:** usuário/chat/grupo/tópico identificado dentro da connection, com consentimento, estado de inscrição e capacidades. Uma connection pode ter vários destinos; um destino não deve ser inferido como contato confiável somente pelo nome.
- **Auditoria e entregas:** eventos de setup, rotação, vinculação, envio, callback e falha com actor, tenant, bot id, destino pseudonimizado, motivo e correlation id; manter conteúdo e segredo fora da trilha operacional sempre que possível.

### Relação com `channel_sessions`

Primeiro ponto de desenho é decidir se Telegram cabe como provider de mensagem em `channel_sessions` ou se precisa de uma entidade de connection própria com ligação composta à sessão/conversa. A tabela atual modela sessão por número/engine/WAHA e carrega invariantes de telefone, aquecimento e status que não descrevem um bot. Reutilizar `channel_sessions` sem inventariar defaults, índices, FKs, triggers, policies RLS, leitores sem filtro de provider e o contrato de instalação poderia transformar Telegram em um “número” fictício ou quebrar outros canais. A alternativa também não pode duplicar inbox, conversas e mensagens sem uma razão medida. Fazer um DIRC de conexão/canal antes de escolher.

Independente do modelo: toda tabela própria precisa de `organization_id`, RLS e testes de isolamento; o service role filtra manualmente por tenant; a migration precisa do apêndice idempotente do baseline e da linha `-- manifest:`.

## Escopo em ondas

### Onda 0 — Descoberta e contrato

- Inventariar todos os invariantes e consumidores de `channel_sessions`, `conversations`, `messages`, `event_log`, `agent_inbox_items`, tools MCP e conexão/health.
- Definir propriedade de bots: token próprio por tenant como padrão; decidir se a instalação também oferece um bot compartilhado de plataforma ou gerenciado. Nunca compartilhar inbox ou token entre tenants.
- Definir o que “app” significa por capability e escolher o primeiro caso que combina valor e risco: atendimento por mensagem, bot interno de avisos ou Mini App de cliente.
- Registrar decisão de adapter, persistence, webhook, webhook vs long polling, política de mídia, modelo de bot/grupo/tópico, identidade, consentimento, entrega e limite de taxa.
- Aprovar a matriz de autorização tenant/admin, lista de ações pelo bot superadmin e política de suporte.

### Onda 1 — Bot API como canal nativo multi-bot

- Adicionar provider Telegram ao seam `lib/channels/`; capabilities como resposta explícita e testada.
- Conectar/desconectar vários bots por tenant; validação de token sem expor segredo; webhook seguro; rotação/revogação; health e ida/volta de teste.
- Ingestão idempotente de mensagens privadas, identidade de chat e envio de texto; mapear conversas à sessão/bot certo e mostrar origem na inbox.
- Política padrão segura: chats individuais; grupos, tópicos e envio proativo requerem ativação e allowlist separadas.
- Guardrails de autorização, rate limit, opt-out, auditoria, falha visível e instalação self-host sem env obrigatória nova.

### Onda 2 — Inbox, agentes e casos humanos

- Responder pela inbox e direcionar cada bot a agente/prompt/base de conhecimento/horário/política de handoff.
- Cobrir mídia que a matriz de capability declarar possível, estados de envio, callbacks/botões e referência à mensagem.
- Integrar casos humanos e avisos de equipe com bot interno independente do bot cliente, sem confundir a identidade do remetente ou expor o caso em grupo.
- Limites por agente, destino e bot; desligar bot/IA e retornar a humano sem perda de conversa.

### Onda 3 — Ferramentas, avisos, workflow e comunicações

- Habilitar tools MCP explicitamente por agente/binding, inicialmente consulta e proposta de ação.
- Enviar avisos e oferecer confirmações que revalidam autorização no callback; deduplicar evento e tornar resposta idempotente.
- Integrar automation rules e campanhas somente com consentimento, controles de volume, unsubscribe e monitoramento.
- Permitir usar Telegram como destino/origem de ferramentas, sem permitir que uma tool escolha token/bot de outra organização.

### Onda 4 — Mini Apps e autoatendimento

- Escolher uma primeira Mini App (ex.: abrir/acompanhar caso ou agendar serviço) com autenticação/associação ao contato.
- Validar `initData`/assinatura e `auth_date` no backend; tratar `initDataUnsafe` apenas como dado de interface.
- Configurar URL, menu button/deep link, identidade visual e bindings no produto; registrar cada app/capability associada a uma connection.
- Depois ampliar para portal de pedidos, propostas, documentos e atualização de consentimento.

### Onda 5 — Business, login, pagamentos e plataforma

- Telegram Business: só usar a conexão de negócio e as permissões explicitamente concedidas pelo usuário; validar os direitos por atualização antes de cada ação.
- Telegram Login/OIDC: iniciar como mecanismo de vínculo/entrada no portal, nunca para conceder função administrativa automaticamente.
- Pagamentos: estudo separado com reconciliação, webhook fonte da verdade, reembolsos e regras de produto/contabilidade; não misturar com envio de mensagens.
- Operações de superadmin por bot separado: começar com leitura de status e avisos; somente depois propor comandos escritos com reautenticação/pairing, escopo, aprovação, auditoria e confirmação do nome do tenant/ação.

## Controles de segurança que precisam ser requisitos de aceite

1. **Tenant em todas as camadas:** conexão e destino vinculados ao `organization_id`; o bot nunca recebe tenant pelo payload como fonte de autoridade. Webhook resolve pelo token forte e verifica bot id/campo de identidade contra a connection.
2. **Segredos:** token de bot, client secret OIDC e tokens de pagamento cifrados no servidor, exibidos uma vez ao configurar; rotação invalida webhook/segredo anterior; nenhum valor em browser, URL, audit, Sentry ou logs.
3. **Identidade:** o username/foto/nome do Telegram não é fator suficiente para relacionar usuário administrativo nem fundir contato; vínculo exige fluxo verificável, consentimento quando aplicável e revogação. O ID do remetente localiza uma identidade de canal, não concede autoridade. Separar ator pareado (usuário ou contato externo), conexão do bot (tenant ou plataforma) e principal que executa (agente/serviço).
4. **Permissão granular:** separar leitura, envio ao cliente, gestão de conexão, gestão de dados, operações de plataforma e suporte cross-tenant; nenhum `admin` do tenant vira platform admin.
5. **Admin por Telegram:** limitar IDs Telegram previamente pareados a usuários DeskcommCRM elegíveis; usar conexão/bot da instalação em escopo de plataforma e mantê-la fora das conexões tenant. Revalidar usuário, papel e escopo em cada ação; autorização depende do servidor, não do prompt do agente. Mutação privilegia proposta + confirmação no próprio chat com destino nomeado; operações de alto impacto podem exigir confirmação web/MFA.
6. **Risco de agente:** ferramentas mutantes com allowlist explícita, escopo tipado, idempotência, limites, policy antes do envio e audit. Conteúdo recebido via Telegram é dado não confiável e não pode alterar system prompt/política.
7. **Resiliência:** webhook autenticado, updates deduplicados e persistidos, fila/retry/DLQ observável, backoff e limite de envio, callback repetido seguro, pausa automática em falha e retorno ao operador.
8. **Privacidade:** retenção e exclusão de conteúdo/mídia e vínculos; minimização em avisos; opt-out por bot/destino; LGPD export/redaction inclui novos identificadores e eventos.
9. **Experiência:** mensagem proativa precisa de base elegível; instalação sem Telegram configurado segue funcionando; falha de um bot não bloqueia outros bots nem o restante do CRM.

## Primeira proposta de experiência

Em **Conexões → Telegram**, mostrar cada bot como uma conexão independente. O formulário “Adicionar bot” pede o nome de identificação e o token emitido pelo BotFather. O botão não diz “adicionar” até validar o token no servidor; o token não deve ficar em query string, logs ou armazenamento do navegador.

Quando `getMe` confirmar o token, criar a conexão como **rascunho inativo**, guardar a credencial cifrada no servidor e abrir imediatamente o modal de configuração daquele bot. O mesmo modal fica disponível pela engrenagem no cartão da conexão. Se a pessoa fechar o modal sem salvar, manter o rascunho inativo e sinalizado como “Configuração pendente”; não registrar webhook, receber mensagens nem habilitar envios até ela salvar e ativar explicitamente. Token inválido não cria conexão e retorna erro que não ecoa o segredo.

O modal separa três decisões que não devem ser confundidas:

1. **Onde será usado (binding):** Inbox/atendimento, avisos, casos humanos, ferramentas de agente ou Mini App. São destinos do produto; conectar o bot por si só não os ativa.
2. **O que pode fazer em cada superfície (capability e escopo):** receber mensagens, permitir resposta humana, encaminhar ao agente, enviar avisos por categorias/destinos escolhidos, participar de grupos autorizados ou executar ferramentas. Cada opção explica o efeito concreto e seu risco.
3. **Quem pode agir:** usuários/contatos Telegram vinculados e permissões DeskcommCRM que continuam sendo verificadas no servidor. Um checkbox de superfície não concede papel, identidade nem acesso amplo ao CRM.

Para reduzir configuração inicial sem adivinhar a intenção pelo token, o modal oferece perfis de uso selecionáveis e editáveis (por exemplo, **Atendimento** ou **Avisos internos**). Atendimento pode vir pré-selecionado como destino Inbox com resposta humana; roteamento para IA, envio proativo, grupos e ferramentas mutantes ficam desligados até escolha explícita. O perfil de avisos seleciona apenas o binding de avisos e exige categorias/destinos. Não pré-selecionar dois usos conflitantes nem deduzir intenção de `getMe`.

**Capacidades avançadas** aparecem separadas, com resumo de risco e estado desligado: grupos, IA automática, envio proativo/campanhas, tools que alteram dados e operações administrativas. O modal de tenant nunca concede administração da plataforma. Operações de superadmin usam a conexão de plataforma separada e identidade de operador pareada, com RBAC, escopo por tenant, auditoria e confirmação; “acesso total” não é uma capability concedida ao agente pelo bot.

A lista apresenta apenas conexões realmente salvas e seus estados reais (rascunho, ativa, pausada ou erro), sem registros ou contagens ilustrativas. Para cada cartão, a engrenagem abre o modal em modo de edição; credenciais são mascaradas e nunca reapresentadas. “Saúde” reporta validação, webhook e última entrada/saída quando esses mecanismos existirem.

- **Atendimento:** recebe conversas na inbox e, opcionalmente, liga a um agente.
- **Avisos da equipe:** envia notificações a destinos escolhidos e só habilita as categorias marcadas.
- **Operações:** começa desabilitado para tenant; é uma superfície de plataforma configurada separadamente.
- **Mini App:** configura uma experiência web e seus pontos de entrada; não herda permissões do bot de atendimento.

Salvar configuração não inicia campanhas nem envia mensagens proativas. Uma jornada de teste confirma update recebido, resposta via canal e destino correto. Cada bot pode ser pausado sem desconectar os demais. Erros de validação, webhook e entrega são visíveis com motivo sanitizado e ação de reparar/revalidar.

## Critérios de sucesso e casos de aceite para detalhar

- Tenant conecta dois bots e cada um mostra nome/saúde, capacidade e finalidade independentes.
- Mensagem recebida pelo bot A aparece na inbox do tenant correto, e a resposta sai pelo bot A mesmo se o bot B estiver conectado.
- Webhook repetido não duplica mensagem, caso, evento de agente nem aviso.
- Token inválido, bot renomeado/revogado, webhook atrasado e limite de envio aparecem como falha acionável; não geram estado saudável falso.
- Um bot de alertas não recebe conteúdo de conversa; só envia categorias e destinos que o manager selecionou.
- Grupo sem allowlist não ingressa nem aciona agente; grupo aprovado não permite resposta automática até a política de IA para grupo ser expressamente habilitada.
- Uma mensagem maliciosa que ordena ao agente ignorar instruções não muda escopo, binding, permissões nem segredo usado.
- Bot do tenant não enxerga tenant vizinho, nem mesmo usando id de chat ou callback que pertence a outra organização.
- Bot de operação não executa como superadmin após receber somente um Telegram ID: precisa de pairing/admin authorization válido. Não opera tenant sem nomeá-lo, sem escopo, sem audit e sem confirmação exigida.
- Mini App rejeita initData adulterado, expirado ou com `auth_date` acima da janela; dados sem assinatura nunca autenticam sessão.
- Login Telegram não atribui `manager`, `admin` ou `platform_admin` sem aprovação de RBAC já existente.
- Desconectar um bot interrompe apenas bindings dele; dados e mensagens já persistidos permanecem sujeitos à política de retenção.
- Em instalação self-host limpa e sem bot, o produto e os demais canais continuam íntegros.

## Métricas a apresentar por tenant e plataforma

- Bots conectados/ativos/pausados, capability e responsável pelo binding.
- Updates recebidos, mensagens aceitas/enviadas, falhas, duplicatas descartadas, atraso de fila e saúde do webhook por bot.
- Alertas enviados/confirmados/expirados por categoria, sem transformar confirmação em ação sem autorização.
- Conversas/casos com origem Telegram, tempo até resposta humana e handoff.
- Uso/custo do agente por bot e canal, com limite configurable e pausa preventiva.
- Eventos admin de conexão, permissão, suporte, pareamento e tentativa recusada.

As métricas de plataforma devem ser agregadas, com drill-down por tenant somente para operador autorizado e com trilha de acesso; nunca expor conteúdo da conversa em dashboard global por padrão.

## Fora do primeiro release

- Importar/raspar histórico Telegram anterior à conexão.
- Criar bots programaticamente em nome do usuário ou guardar token gerenciado automaticamente sem análise própria de política e operação.
- Ler qualquer mensagem de qualquer grupo por padrão, fazer moderação automática ou participar de conversas entre bots sem controle de ciclo.
- Liberar acesso irrestrito ao CRM para um agente via superadmin.
- Pagamentos, reembolsos, movimentação financeira e credenciais de pagamento.
- Anexar a Mini App ao attachment menu, guest/inline bot, gerenciamento de bots, jogos ou funcionalidades que dependam de elegibilidade/restrições próprias da plataforma antes de validar requisitos e política.

## Decisões em aberto antes de virar spec aprovada

1. Quem fornece cada bot: token do tenant, bot do dono da instalação, bot da Servinder para uso comum, ou mais de um modelo com isolamento rigoroso?
2. Primeiro valor a lançar: inbox/atendimento Telegram ou bot operacional de avisos? Recomendação inicial: conectar e provar **dois bots do tenant** na inbox e em avisos como bindings independentes; manter administração global como fase posterior.
3. Conexão Telegram vira provider de `channel_sessions`, usa tabela própria ligada a conversation, ou outro seam? Exigir auditoria de invariantes antes de decidir.
4. Um mesmo bot pode atender vários agentes conforme chat/tema/horário? Quem decide prioridade quando vários bots/apps respondem ao mesmo chat?
5. Grupos e tópicos: devem existir no MVP? Recomendação: privado primeiro; grupos exigem allowlist, opt-in e modo IA desligado por padrão.
6. Armazenamento e retenção de mídia; download e limites de tamanho; id de arquivo do Telegram fica armazenado por quanto tempo?
7. Que botões/callbacks podem efetuar mudança sem abrir o CRM, e quais exigem web/MFA?
8. Para bot superadmin, qual lista inicial de comandos de leitura e quais ações serão recusadas categoricamente por chat?
9. Mini App de valor imediato é abrir caso, acompanhar caso, agendamento ou portal de pedidos? Qual tenant/público piloto?
10. Nível de suporte ao Telegram Business, login e pagamentos que o produto quer assumir e suportar em instalação self-host.

## Referências oficiais consultadas

- [Telegram Bot API](https://core.telegram.org/bots/api) — webhook, updates, comandos, mensagens e permissões da API.
- [Telegram Bot Features](https://core.telegram.org/bots/features) — bots, Business connections, Mini Apps, grupos/comunidades, comunicação bot-a-bot e pagamentos.
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps) — pontos de entrada e validação de `initData` no servidor; [Direct Mini Apps](https://core.telegram.org/api/bots/webapps) — um bot pode oferecer várias Mini Apps identificadas por `short_name`.
- [Telegram Business](https://core.telegram.org/api/business) — direitos concedidos na conexão de negócio.
- [Log In With Telegram](https://core.telegram.org/bots/telegram-login) — OIDC, scopes, `state`/PKCE e validação de ID token.
- Doutrina interna: `CLAUDE.md`, `docs/doctrine/restricao-de-canal.md`, `docs/doctrine/sistema-vivo.md`, `docs/specs/01-spec-platform-base.md`, `docs/specs/10-spec-ai-agents-runtime.md`, `docs/specs/11-spec-mcp-server-internal.md`, `docs/specs/15-spec-casos-humanos.md` e `docs/specs/16-spec-tres-papeis-do-agente.md`.
