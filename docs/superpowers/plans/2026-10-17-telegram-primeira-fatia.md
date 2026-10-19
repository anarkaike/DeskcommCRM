# Telegram — primeira fatia funcional

> Estado medido em 2026-10-19: apenas cadastro/validação de bots foi implementado na branch `codex/telegram-vps-compatible` (commit `52f2e3492`); o runtime não está ativo. Base de produto: [`../specs/2026-10-17-integracao-telegram-design.md`](../specs/2026-10-17-integracao-telegram-design.md).
> Essa etapa conecta e configura bots; não declara o runtime de mensagens pronto.

## Objetivo desta etapa

Permitir que um administrador do tenant valide e registre vários tokens de bots Telegram, configure para que superfícies cada conexão ficará reservada e reabra essa configuração pelo botão de engrenagem. O token nunca retorna ao navegador depois do POST. Um bot validado começa como rascunho e permanece sem webhook/envio até a etapa de transporte.

## Decisões e limites

- Criar um domínio próprio de conexões Telegram; não representar bot como sessão WAHA nem presumir que `channel_sessions` não tenha invariantes de telefone e lifecycle.
- Validar o token pelo `getMe` no servidor antes de persistir. Guardar por `fn_encrypt_oauth`; se a chave de instalação estiver ausente, recusar sem persistência.
- Armazenar o token cifrado numa tabela service-role-only, isolada por `organization_id`. Rotas de tenant exigem `requireRole("admin")` e filtram a organização em toda operação.
- Persistir bindings e capacidades de forma tipada e distinta da credencial. Operações de plataforma não pertencem ao tenant e não aparecem como checkbox deste modal.
- Após `getMe`, criar rascunho e abrir o modal. Perfis de uso são presets editáveis; o padrão é Inbox com resposta humana. IA automática, grupos, envio proativo e ferramentas que escrevem ficam desligados.
- Exibir estados verdadeiros. Nesta etapa, “configurado” significa token validado e usos salvos; ainda não significa webhook recebendo mensagens.
- Não implantar migration nem imagem na VPS nesta etapa sem uma autorização específica para atualizar o ambiente e o banco.

## Entregas

1. Contrato de persistência para conexões e usos/bindings, com migration versionada e espelho idempotente no apêndice de `supabase/baseline.sql`.
2. `GET` para listar conexões sem segredo, `POST` para validar e criar rascunho, `PATCH` para salvar bindings; todas as mutações auditadas.
3. Cliente de servidor Telegram para `getMe`, com timeout, erros sanitizados e sem registrar token/URL em log.
4. UI de Conexões: lista real/estado vazio, formulário funcional, abertura automática do modal após validação, engrenagem para editar e avisos claros sobre o runtime ainda indisponível.
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

### Recorte do primeiro runtime de mensagens

O primeiro marco de tráfego será atendimento tenant em **chat privado**, com entrada autenticada,
idempotência por bot/update, contato reconhecido por identidade opaca, conversa na Inbox e resposta
humana de texto pelo mesmo bot. IA, grupos/tópicos, mídia, alertas, casos, ferramentas de agente,
Mini Apps, Login/OIDC, Telegram Business, pagamentos e operação de plataforma permanecem
desativados até terem contratos, autorização e testes próprios. “Bot cadastrado” e “Telegram ativo”
devem ser estados distintos, com teste de ida e volta antes da ativação.

### Bloqueio para publicação na VPS

Em 2026-10-19, o fork remoto `main` está em `e6060a4`; a branch de cadastro está em
`52f2e3492`, publicada no fork. A VPS `/opt/deskcommcrm` está detached em `1c4716588` (`v1.83.0`),
com o app numa imagem local `deskcommcrm:telegram-preview-df33c72c0`, worker e scheduler em
`1.83.0`, `SINGLE_SERVER=1`, Traefik ativo e health HTTP 200. Um backup privado prévio do banco,
storage e WAHA foi criado em 2026-10-19; nenhum código, banco ou container foi alterado nesta
auditoria. Atualizar agora só publicaria o formulário de cadastro, não o ciclo de mensagens.

## Aceitação desta etapa

- Token inválido não cria conexão e nenhuma resposta/log ecoa o token.
- Token válido é cifrado, identificado por nome/username/id do bot e não pode ser lido via GET.
- Mesmo bot não pode ser cadastrado duas vezes na mesma organização; outra organização permanece isolada.
- A configuração abre após validar e também pelo controle de engrenagem; bindings persistem sem conceder papel.
- O status e a mensagem deixam claro que nenhum update ou envio de Telegram está ativo até o runtime ser entregue.
- Migration e baseline são idempotentes, RLS/grants são verificáveis, e a interface é provada pelo browser antes da conclusão.
