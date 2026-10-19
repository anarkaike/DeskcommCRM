# Telegram — primeira fatia funcional

> Estado atualizado em 2026-10-19: cadastro, lifecycle, webhook, Inbox privada para texto/mídia e adapter de saída estão implementados localmente na branch `codex/telegram-vps-compatible`; ainda sem prova visual ponta a ponta ou publicação na VPS. Os contratos inbound e outbound reutilizam as portas comuns de canais. Base de produto: [`../specs/2026-10-17-integracao-telegram-design.md`](../specs/2026-10-17-integracao-telegram-design.md).
> Esta página registra o primeiro recorte de implementação; os recursos avançados listados como pendentes permanecem fora do runtime.

## Objetivo desta etapa

Permitir que um administrador do tenant valide e registre vários tokens de bots Telegram, configure para que superfícies cada conexão ficará reservada e reabra essa configuração pelo botão de engrenagem. O token nunca retorna ao navegador depois do POST. Este foi o objetivo original da primeira fatia; os marcos seguintes agora incluem tráfego privado na Inbox.

## Decisões e limites

- Criar um domínio próprio de conexões Telegram; não representar bot como sessão WAHA nem presumir que `channel_sessions` não tenha invariantes de telefone e lifecycle.
- Validar o token pelo `getMe` no servidor antes de persistir. Guardar por `fn_encrypt_oauth`; se a chave de instalação estiver ausente, recusar sem persistência.
- Armazenar o token cifrado numa tabela service-role-only, isolada por `organization_id`. Rotas de tenant exigem `requireRole("admin")` e filtram a organização em toda operação.
- Persistir bindings e capacidades de forma tipada e distinta da credencial. Operações de plataforma não pertencem ao tenant e não aparecem como checkbox deste modal.
- Após `getMe`, criar rascunho e abrir o modal. Perfis de uso são presets editáveis; o padrão é Inbox com resposta humana. IA automática continua desligada por padrão; quando concedida, usa o pipeline existente de autorização e política. Grupos, envio proativo e ferramentas que escrevem permanecem sem consumidor.
- Exibir estados verdadeiros. “Configurado” significa token validado e usos salvos; “ativo” exige webhook registrado e runtime operacional.
- Não implantar migration nem imagem na VPS nesta etapa sem uma autorização específica para atualizar o ambiente e o banco.

## Entregas

1. Contrato de persistência para conexões e usos/bindings, com migration versionada e espelho idempotente no apêndice de `supabase/baseline.sql`.
2. `GET` para listar conexões sem segredo, `POST` para validar e criar rascunho, `PATCH` para salvar bindings; todas as mutações auditadas.
3. Cliente de servidor Telegram para `getMe`, com timeout, erros sanitizados e sem registrar token/URL em log.
4. UI de Conexões: lista real/estado vazio, formulário funcional, abertura automática do modal após validação, engrenagem para editar e estado/saúde do webhook.
5. Tipos DB focados nos objetos novos e controles de autorização/isolamento correspondentes.

## Próximas etapas (fora desta fatia)

1. Webhook Telegram autenticado, idempotência, normalização de updates e health por bot.
2. Pareamento verificável `Telegram User ID → usuário DeskcommCRM` ou `contact`, separado do `chat.id`.
3. Inbox e respostas humanas; depois avisos, agentes, casos, ferramentas e Mini Apps, cada qual consumindo bindings reais.
4. Bot de operações da plataforma separado, pareamento de `platform_admin` e escopos de operação auditáveis.

## Estado medido e decisão de arquitetura — 2026-10-19

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

O runtime de mensagens agora cobre entrada de texto, foto, áudio, vídeo e documento em chat privado;
os bytes passam pelo `fetchInboundMedia` do adapter e pelo worker comum de Storage, e a saída admite
texto e esses tipos de mídia pelo `ChannelAdapter`. Respostas citadas também usam o envelope comum,
traduzidas para `message_id` na fronteira Telegram. IA ainda é conservadora para texto enquanto mídia
aguarda persistência/derivação; grupos, edição, envio proativo, avisos, casos, ferramentas, Mini Apps,
Business, Login/OIDC, pagamentos e operação da plataforma seguem sem consumidor. Migration, baseline
install/update, isolamento/grants e testes focados passaram em banco descartável; ainda falta prova
visual/e2e em instalação configurada antes de release.

### Recorte do runtime de mensagens entregue no código local

O primeiro marco de tráfego é atendimento tenant em **chat privado**, com entrada autenticada,
idempotência por bot/update, contato reconhecido por identidade opaca, conversa na Inbox e respostas
humanas de texto e mídia pelo mesmo bot. IA para texto usa o pipeline existente sob capability; os
demais recursos da matriz acima seguem desativados até terem consumidores, autorização e testes
próprios. “Bot cadastrado” e “Telegram ativo” são estados distintos; a ativação exige
`receive_messages` e pelo menos uma capability de resposta.

### Bloqueio para publicação na VPS

Em 2026-10-19, o fork remoto `main` está em `e6060a4`; a branch de cadastro está em
`52f2e3492`, publicada no fork. A VPS `/opt/deskcommcrm` está detached em `1c4716588` (`v1.83.0`),
com o app numa imagem local `deskcommcrm:telegram-preview-df33c72c0`, worker e scheduler em
`1.83.0`, `SINGLE_SERVER=1`, Traefik ativo e health HTTP 200. Um backup privado prévio do banco,
storage e WAHA foi criado em 2026-10-19; nenhum código, banco ou container foi alterado nesta
auditoria. Atualizar agora só publicaria o formulário de cadastro, não o ciclo de mensagens.

## Aceitação atual do runtime privado

- Token inválido não cria conexão e nenhuma resposta/log ecoa o token.
- Token válido é cifrado, identificado por nome/username/id do bot e não pode ser lido via GET.
- Mesmo bot não pode ser cadastrado duas vezes na mesma organização; outra organização permanece isolada.
- A configuração abre após validar e também pelo controle de engrenagem; bindings persistem sem conceder papel.
- Updates privados autenticados e duplicados não geram mensagens duplicadas; falhas de ingestão permitem retry.
- Texto, mídia e respostas citadas usam a Inbox, o pipeline de mídia e o adapter comum sem expor o token.
- Migration e baseline são idempotentes, RLS/grants são verificáveis, e interface e ida/volta real são provadas no browser antes da conclusão.
