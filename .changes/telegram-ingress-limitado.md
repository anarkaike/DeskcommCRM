---
impacto: nada_mudou
secao: corrigido
titulo: Webhook Telegram interrompe corpos acima do limite durante a leitura
---

Atualizações acima de um megabyte são recusadas durante a leitura, inclusive sem Content-Length. Leituras interrompidas não gravam mensagens parciais; a autenticação e a fila idempotente permanecem no mesmo caminho.
