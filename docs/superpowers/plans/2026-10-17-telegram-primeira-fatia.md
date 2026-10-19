# Telegram — primeira fatia funcional

> Estado atualizado em 2026-10-19: a integração funcional do Telegram está implementada na branch `codex/telegram-vps-compatible`, incluindo credencial, lifecycle, webhook, Inbox privada e grupos com allowlist, texto/mídia e resposta humana. Esta branch também incorpora localmente a release upstream 1.85.0 para atualizar a base da VPS 1.83.0. Não houve push nem PR para o repositório de produto. Banco focado passou antes da incorporação de 1.85; validação final, prova visual e deploy ainda estão pendentes. Base: [`../specs/2026-10-17-integracao-telegram-design.md`](../specs/2026-10-17-integracao-telegram-design.md).
> Telegram já reutiliza `ChannelAdapter`, `InboundChannelDriver`, `InboundMessageEvent`, persistência compartilhada, registro de drivers e lifecycle comum. A descoberta de grupos é limitada ao que o bot efetivamente recebe; mensagens de grupo ficam bloqueadas até um gerente habilitá-las e sempre entram só na Inbox humana. Proativo, avisos, casos, ferramentas, Mini Apps, pareamento externo e bot operacional continuam fora do runtime.

## Objetivo desta etapa

Permitir que um administrador do tenant valide e registre vários tokens de bots Telegram, configure para que superfícies cada conexão ficará reservada e reabra essa configuração pelo botão de engrenagem. O token nunca retorna ao navegador depois do POST. Este foi o objetivo original da primeira fatia; os marcos seguintes agora incluem tráfego privado na Inbox.

## Decisões e limites

- Criar um domínio próprio de conexões Telegram; não representar bot como sessão WAHA nem presumir que `channel_sessions` não tenha invariantes de telefone e lifecycle.
- Validar o token pelo `getMe` no servidor antes de persistir. Guardar por `fn_encrypt_oauth`; se a chave de instalação estiver ausente, recusar sem persistência.
- Armazenar o token cifrado numa tabela service-role-only, isolada por `organization_id`. Rotas de tenant exigem `requireRole("admin")` e filtram a organização em toda operação.
- Persistir bindings e capacidades de forma tipada e distinta da credencial. Operações de plataforma não pertencem ao tenant e não aparecem como checkbox deste modal. Um provider novo implementa os ports de conexão e mensagem e registra seu adapter; persistência e efeitos do CRM continuam no serviço comum.
- Após `getMe`, criar rascunho e abrir o modal. Perfis de uso são presets editáveis; o padrão é Inbox com resposta humana. IA automática e grupos continuam desligados por padrão; mensagens de grupo requerem capability e allowlist por conversa, nunca acionam IA. Envio proativo e ferramentas que escrevem permanecem sem consumidor.
- Exibir estados verdadeiros. “Configurado” significa token validado e usos salvos; “ativo” exige webhook registrado e runtime operacional.
- A atualização da VPS e do banco foi autorizada pelo usuário nesta conversa. Fazer backup, confirmar o modo de deploy, aplicar a migration aditiva e validar rotas e runtime antes de considerar concluída.

## Entregas

1. Contrato de persistência para conexões e usos/bindings, com migration versionada e espelho idempotente no apêndice de `supabase/baseline.sql`.
2. `GET` para listar conexões sem segredo, `POST` para validar e criar rascunho, `PATCH` para salvar bindings; todas as mutações auditadas.
3. Cliente de servidor Telegram para `getMe`, com timeout, erros sanitizados e sem registrar token/URL em log.
4. UI de Conexões: lista real/estado vazio, formulário funcional, abertura automática do modal após validação, engrenagem para editar e estado/saúde do webhook.
5. Tipos DB focados nos objetos novos e controles de autorização/isolamento correspondentes.

## Extensões que continuam fora do runtime Telegram

1. Envio proativo iniciado pela equipe/automações, limitado pela política de consentimento e pela identidade de chat previamente conhecida.
2. Avisos da equipe, casos, ferramentas de agente e Mini Apps, cada qual com consumidor, autorização e testes próprios.
3. Bot operacional da plataforma, separado do tenant, com identidade `platform_admin` e escopos auditáveis.
4. Edição/apagamento de mensagens, Business, Login/OIDC e pagamentos Telegram.

## Auditoria histórica e decisão de arquitetura — 2026-10-19

Os parágrafos iniciais desta seção registram o estado observado antes do runtime Telegram; não descrevem mais o estado atual. Eles ficam como contexto das invariantes descobertas.

O deploy da primeira fatia **não** ativa Telegram. A UI mostra corretamente o aviso de que o
transporte ainda não foi ativado. O runtime precisa de uma etapa arquitetural antes do webhook:

- `channel_sessions.provider` não aceita Telegram; a tabela representa sessões com invariantes
  de telefone/WAHA e ciclo de vida de canais existentes. Não inserir bots ali como sessões.
- `conversations.channel` atualmente aceita `whatsapp`, `instagram` e `facebook`, mas toda
  conversa exige `channel_session_id` com FK para `channel_sessions`.
- `messages.channel_session_id` também é NOT NULL e referencia `channel_sessions`.
- O envio central (`app/api/v1/messages/_handler.ts`) carrega sessão e telefone/identidade do
  contato, seleciona `ChannelAdapter` e usa caminhos de mídia/template; IA, follow-up, casos,
  roteamento e rotinas de serviço também leem `channel_session_id`.
- `contacts.social_identity` e `conversations.provider_conversation_id` suportam identificadores
  opacos/thread id, mas não removem as obrigações de sessão nem os efeitos dos triggers em
  `messages`.
- Há triggers de serviço, roteamento, eventos, revisão e demanda ligados à criação de mensagens.
  Antes de admitir Telegram no ledger compartilhado, é preciso provar quais se aplicam e fazer
  canais existentes permanecerem invariantes.

Desde esta auditoria, a branch local também ganhou o ciclo administrativo de webhook, endpoint que
autentica o `secret_token` da Bot API, fila idempotente, worker agendado e tradução de mensagem
privada de texto para contato/conversa/mensagem no ledger compartilhado. A resposta humana de texto
na Inbox usa o adapter da Bot API e exige a capability `human_replies`. A fila apaga o payload bruto
após processamento, retém recibos por 30 dias e faz retry limitado para falhas transitórias.

O limite de arquitetura entre provedores está mais claro: `InboundChannelDriver` representa a porta
de entrada já autenticada/traduzida, `getInboundDriver` seleciona o driver sem fallback, e
`InboundMessageEvent` é o contrato canônico entregue a `persistirMensagemEntranteNaInbox`. Esse caso
de uso aplica a chave idempotente e os efeitos comuns (marcador da conversa, opt-out, handoff e
automações) e agenda mídia pelo mesmo `event_log` usado pelos demais canais. Telegram implementa o
driver em `lib/channels/telegram/driver.ts`; o worker consome a porta do registro, sem importar o
parser Telegram. Um próximo provedor pode implementar essa porta e reutilizar o ledger/efeitos,
Storage e derivação de mídia, mantendo autenticação, identidade, destinos, API externa, retries e
capabilities específicas no seu próprio adapter. Não se generaliza credencial ou fila antes de
existir um segundo fluxo com invariantes equivalentes.

O caminho de saída já tinha `ChannelAdapter` e `getAdapter`; agora há uma porta correspondente para
ingresso. O padrão é **Ports and Adapters** (drivers de protocolo nas bordas), com **Registry** de
composição e um **Application Service** comum para persistir mensagens. Não há interface genérica
para cada chamada Bot API nem abstração de provedor fictícia: o contrato representa o comportamento
estável que já foi medido e é compartilhável.

O destino remoto da conversa também passou a ser persistido por `fn_upsert_telegram_conversation`.
Sem `provider_conversation_id`, a conversa aparecia na Inbox mas o adapter de saída não tinha o
`chat_id` para localizar o destinatário; a migration `0707` fecha essa lacuna sem derivar telefone.

O runtime de mensagens cobre entrada e saída de texto, foto, áudio, vídeo e documento em chats
privados; os bytes passam pelo `fetchInboundMedia` do adapter e pelo worker comum de Storage.
Respostas citadas usam o envelope comum e são traduzidas para `message_id` na fronteira Telegram.
Grupos são descobertos apenas por updates observados, ficam desligados até allowlist explícita e
permanecem fora da IA. Envio proativo, avisos, casos, ferramentas, Mini Apps, Business, Login/OIDC,
pagamentos e operação da plataforma seguem sem consumidor. A migration de grupos conserva a fachada
RPC antiga de quatro argumentos sem ambiguidade no Postgres.

### Recorte do runtime de mensagens entregue no código local

O recorte tenant cobre entrada autenticada e idempotente, contato por identidade opaca, conversa na
Inbox, texto e mídia e respostas humanas pelo mesmo bot. IA usa o pipeline existente sob capability;
grupos são estritamente humanos e allowlisted. “Bot cadastrado” e “Telegram ativo” são estados
distintos; ativação exige `receive_messages` e ao menos uma capability de resposta.

### Bloqueio para publicação na VPS

Leitura atual em 2026-10-19: o app, worker e scheduler da VPS estão em `v1.83.0`; o checkout
`/opt/deskcommcrm` está detached em `1c4716588`. A imagem do app é `ghcr.io/melgarafael/deskcommcrm:1.83.0`.
O host da captura, `vendas.servinder.com.br`, responde 200 em `/` e 307 em `/app`; a rota de
`crm.servinder.com.br` responde 503 e não é o domínio desta instalação. A configuração do app usa
Compose em `/opt/deskcommcrm` com labels Traefik e não mostrou timers nem cron jobs de CRM; não
encontramos labels `coolify.*` no container. A release 1.85.0 foi obtida do remote de produto em
modo leitura e incorporada só nesta branch local. Nenhuma migration, imagem ou container foi alterado
na VPS nesta rodada.

## Aceitação atual do runtime privado

- Token inválido não cria conexão e nenhuma resposta/log ecoa o token.
- Token válido é cifrado, identificado por nome/username/id do bot e não pode ser lido via GET.
- Mesmo bot não pode ser cadastrado duas vezes na mesma organização; outra organização permanece isolada.
- A configuração abre após validar e também pelo controle de engrenagem; bindings persistem sem conceder papel.
- Updates privados autenticados e duplicados não geram mensagens duplicadas; falhas de ingestão permitem retry.
- Texto, mídia e respostas citadas usam a Inbox, o pipeline de mídia e o adapter comum sem expor o token.
- Migration e baseline são idempotentes, RLS/grants são verificáveis, e interface e ida/volta real são provadas no browser antes da conclusão.
