# Desenvolvimento e release de um fork privado

A branch `main` do fork é a integração compartilhada e a origem de releases próprias.
O repositório oficial é uma fonte de leitura. A autorização para publicar no fork não
inclui publicação, PR, comentário ou release no oficial.

## Desenvolvimento

1. Confirmar checkout, `git status`, remotes, branch, stashes e worktrees.
2. Trabalhar no checkout WSL compartilhado, em `main`, com banco local e hot reload.
3. Antes de reconciliar: salvar bundle de todas as refs, patches do índice e do
   working tree, arquivos não rastreados e inventário dos worktrees. Guardar fora
   do checkout, com acesso restrito. Arquivos de ambiente permanecem no seu host.
4. Ler o oficial somente pelo remote de leitura e fazer merge explícito em `main`.
   Resolver cada conflito preservando os comportamentos aceitos. Nunca resetar,
   rebasear ou forçar a integração para substituir um dos históricos.
5. Validar o resultado e enviar por fast-forward ao fork. `origin` aponta para o
   fork; os remotes oficiais têm push desabilitado. Um hook local confere o URL
   real do destino, inclusive quando o push usa URL em vez do nome do remote.
6. Novos agentes usam o mesmo checkout e banco. Um worktree experimental preservado
   deve ficar bloqueado, com razão registrada, até uma revisão explícita.

Branches antigas só saem da lista ativa depois de terem sua ref preservada em tag
`archive/<data>/<nome>`, no bundle e no fork. Confirmar se o comportamento foi
integrado, substituído ou continua experimental; ancestralidade sozinha não prova
que a implementação mais nova preservou uma funcionalidade.

## Artefato de release

O fonte é um commit já enviado à `origin/main`, não os arquivos abertos no editor.
O script `scripts/fork/release.py` recusa checkout sujo, origem diferente do fork,
repositório oficial como destino e arquivos de ambiente rastreados. Ele não ativa
serviços. A exportação usa `git archive`, incluindo as exclusões no manifesto, e
registra hash SHA-256, árvore Git, commit e as bases dos três runtimes.

Exemplo, com os commits efetivamente instalados obtidos do inventário da produção:

```bash
python3 scripts/fork/release.py \
  --fork https://github.com/SEU-FORK/DeskcommCRM.git \
  --revision main \
  --app-base COMMIT_APP \
  --worker-base COMMIT_WORKER \
  --scheduler-base COMMIT_SCHEDULER \
  --output /caminho-fora-do-checkout/release-COMMIT \
  --export
```

A release conservadora sincroniza `app`, `worker` e `scheduler`. Atualizar só o app
exige provar no diff que nenhuma biblioteca, contrato de fila, configuração,
variável, schema ou cron consumido pelos outros serviços mudou. Diferenças entre
SHAs, por si sós, não provam defeito; diferenças de contrato não verificadas bloqueiam
ativação. A versão exibida pelo checkout não comprova a versão de um container.

## Deploy por SSH

O acesso é por SSH ao host da instalação. Host, diretório, usuário SSH, projeto
Compose e lista ordenada de arquivos Compose ficam na configuração privada do
operador. Não copiar esses dados nem segredos para o fonte genérico.

1. Confirmar aceite local, checks da revisão e compatibilidade do banco. Se o
   manifesto sinaliza schema, revisar as migrations e testar banco fresco e
   atualização com dados antes da ativação. Usar o mecanismo canônico do kit para
   aplicar o baseline; não executar fragmentos SQL escolhidos à mão.
2. Obter o projeto e os arquivos Compose das labels dos containers vivos.
   Comparar com a topologia esperada e recusar divergência não explicada.
3. Preservar banco, configuração, referências Git, fontes disponíveis, IDs das
   imagens e imagens de rollback. Confirmar que o backup terminou e é legível.
4. Transferir o artefato do commit por SSH para uma pasta de release. Conferir seu
   SHA-256 no destino. Nunca usar `rsync --delete` na raiz da instalação, copiar
   `.env` de desenvolvimento ou substituir volumes e credenciais.
5. Construir apenas os serviços afetados a partir dessa pasta imutável, com tags
   do commit e labels OCI de origem/revisão em **cada** imagem. Não usar `latest`,
   nem publicar uma imagem própria no namespace do oficial.
6. Antes da troca, registrar plano de rollback e conferir imagens, serviços e
   schema. Se vários serviços mudam, todos precisam estar prontos antes da troca.
7. Fixar as imagens na configuração da instalação e recriar só os serviços
   previstos, com todos os overlays Compose. Nunca `compose down` da stack inteira.
8. Verificar estado e saúde de cada serviço, roteamento HTTP público e o caminho
   funcional alterado. Registrar duração e uso de CPU/memória/disco medidos.
9. Gravar manifesto instalado com IDs/digests reais, commit, árvore, arquivo de
   fonte, schema e resultados. A tag Git da pasta de operação é metadado do kit;
   o manifesto instalado e as imagens são a evidência do runtime.

O updater oficial não pode substituir imagens próprias automaticamente. A migração
para uma release oficial passa pela reconciliação das customizações e por novo plano.
Não se declara rollback do banco seguro só porque as imagens antigas foram guardadas.

## Recuperação e verificações

Nunca apagar um stash, worktree sujo, branch com commits únicos ou imagem em uso
para limpar a lista. Preservar primeiro e registrar o destino de recuperação.

```bash
python3 -m unittest discover -s scripts/fork -p 'test_*.py' -v
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
pnpm lint
pnpm lint:channels
pnpm lint:role-rank
pnpm exec vitest run --maxWorkers=2
```

Schema exige `test:db` e `test:db:update`; alterações de kit/Compose/Dockerfile
exigem `test:shell`; UX exige prova pelo navegador. Checks pendentes ou falhas
ficam registrados e impedem chamar a revisão de pronta para produção.

O fork reserva os descritores 9700–9799 para suas migrations. O timestamp inicial
é a identidade do Supabase e permanece estável nas renumerações do descritor.
O gate de colisão é repetido após cada merge do oficial.

A suíte unitária ignora `.env` e `.env.local` por padrão. Uma investigação que
realmente precise do ambiente local pode optar por `DESKCOMM_UNIT_USE_LOCAL_ENV=1`;
essa execução, o resultado não equivale ao gate unitário isolado.
