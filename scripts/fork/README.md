# Releases próprias

`release.py` prepara um manifesto e, com `--export`, um arquivo imutável do commit
já publicado no fork. Não envia fonte, não acessa segredos e não troca serviços.
O procedimento de validação, SSH, ativação e recuperação está em
[`docs/runbooks/private-fork.md`](../../docs/runbooks/private-fork.md).

Teste independente de rede e de serviços externos:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/fork -p 'test_*.py' -v
```
