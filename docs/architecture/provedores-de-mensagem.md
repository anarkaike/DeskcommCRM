# Como adicionar um provedor de mensagens

O DeskcommCRM trata cada plataforma como uma borda de protocolo ligada a casos de uso comuns. A UI e o domínio não devem falar diretamente com a API externa. O desenho usa **Ports and Adapters** para separar protocolo, **Strategy** para selecionar o adapter correto por canal, e **Registry/Composition Root** para registrar implementações. O lifecycle aplica a política comum antes de chamar a operação remota do provedor.

## Contratos reutilizados

- `ChannelAdapter`: envio, mídia, resposta citada e recursos específicos do canal; selecionado por `getAdapter(provider)`.
- `InboundChannelDriver`: valida/normaliza update autenticado para o contrato canônico `InboundMessageEvent`; registrado em `lib/channels/inbound/registry.ts`.
- `persistirMensagemEntranteNaInbox`: aplicação comum que grava contato/conversa/mensagem com idempotência e aciona os efeitos compartilhados do CRM.
- `ChannelConnectionDriver`: valida credencial, ativa/desativa o transporte remoto e consulta saúde sem devolver segredo.
- `createConnectionLifecycle` e `decideConnectionLifecycle`: estados e grants comuns; `ChannelConnectionRegistry` faz a composição por provider.
- `capabilitiesOf(provider)`: descreve o que o canal suporta. Permissão concedida ao tenant continua sendo dado separado e é verificada no servidor.

## Checklist para um novo canal

1. Adicionar o identificador ao tipo `ChannelProvider`, ao vocabulário do banco e à matriz de capabilities. Declarar limites reais do canal; não habilitar envio/IA por inferência.
2. Implementar `ChannelAdapter` no diretório do provider e registrá-lo no mapa de adapters. O adapter traduz destinatários e envelopes comuns para o protocolo externo.
3. Implementar `InboundChannelDriver`, validar assinatura/segredo antes da fila e registrar o driver. Converter o payload para `InboundMessageEvent`; chamar a persistência comum, sem duplicar criação de contato, conversa, idempotência ou efeitos do CRM.
4. Se a conexão usa credencial remota, implementar `ChannelConnectionDriver` e registrá-lo. Reutilizar as transições/grants de `createConnectionLifecycle`; manter token, webhook, retries e health específicos na borda do provider.
5. Ligar a fila e o worker do provider ao driver. Fila, limites de retry e retenção só devem ser compartilhados quando tiverem as mesmas garantias; não force dialetos diferentes numa fila genérica.
6. Implementar API e UI que usem os contratos compartilhados, escopem todas as consultas pelo tenant e nunca devolvam segredo. A tela declara capabilities reais e estados confirmados pelo servidor.
7. Atualizar `ChannelSessionRef`, consultas que filtram canais, tipos gerados e políticas de roteamento/envio que precisam conhecer o novo canal. Não adicionar o provider a listas por conveniência: escolha capacidade específica, como `PROVIDERS_DE_ENVIO_AUTOMATIZADO`, e prove o efeito pretendido.
8. Adicionar testes de contrato para adapter, driver, grants/lifecycle, isolamento, idempotência, mídia e falha do provider; provar a jornada pela UI e pelo backend local.

Não é necessário generalizar cada chamada HTTP nem a forma da credencial. O contrato comum é o comportamento estável; detalhes exclusivos de cada API ficam no adapter e no driver daquele provedor. Falhas são *fail-closed*: conexão desconhecida, capability ausente ou adapter não registrado não faz fallback para outro canal.
