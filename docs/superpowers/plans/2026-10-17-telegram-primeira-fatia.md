# Telegram — primeira fatia funcional

> Plano de implementação da primeira etapa. Base de produto: [`../specs/2026-10-17-integracao-telegram-design.md`](../specs/2026-10-17-integracao-telegram-design.md).
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

## Aceitação desta etapa

- Token inválido não cria conexão e nenhuma resposta/log ecoa o token.
- Token válido é cifrado, identificado por nome/username/id do bot e não pode ser lido via GET.
- Mesmo bot não pode ser cadastrado duas vezes na mesma organização; outra organização permanece isolada.
- A configuração abre após validar e também pelo controle de engrenagem; bindings persistem sem conceder papel.
- O status e a mensagem deixam claro que nenhum update ou envio de Telegram está ativo até o runtime ser entregue.
- Migration e baseline são idempotentes, RLS/grants são verificáveis, e a interface é provada pelo browser antes da conclusão.
