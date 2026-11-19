# Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores, via HTTP e SQS. A avaliação é centrada em correção financeira, concorrência entre múltiplas instâncias, idempotência persistente, consistência saldo × ledger, processamento assíncrono e recuperação após falhas.

## Stack obrigatória

- **Bun 1.x** (runtime, package manager e test runner)
- **TypeScript** em modo estrito
- **NestJS**
- **MikroORM**
- **PostgreSQL**
- **AWS SQS** via LocalStack
- **Docker Compose**
- Migrations versionadas e **reversíveis**

Prisma e outros ORMs estão fora do escopo.

## Restrições invioláveis

1. Não usar `number`, `float` ou `double` para dinheiro.
2. Não usar cache em memória como garantia de idempotência.
3. Não confiar apenas em SQS FIFO para garantir consistência.
4. Não publicar eventos antes do commit da transação financeira.
5. Não sobrescrever nem excluir lançamentos do ledger.
6. Não usar lock global compartilhado por todas as wallets.
7. Não implementar saldo como `read → calculate → update` sem controle de concorrência.
8. A solução deve estar correta com **múltiplas instâncias** da aplicação.
9. Unicidade, imutabilidade e não-negatividade são garantidas **no schema do banco**, não só no código.

Falhas eliminatórias adicionais: saldo negativo por race, débito/crédito duplicado, ausência de ledger auditável e testes que substituem completamente PostgreSQL e SQS por mocks.

## Modelagem de domínio

- Domínio puro: sem dependência de NestJS nem de decorators/tipos do ORM.
- Construtor `private`/`protected` + factories estáticas (`create`, `from`, `rehydrate`).
- `rehydrate` reconstrói estado persistido e **não** revalida transições.
- `Money` é imutável; valores trafegam como string decimal com 2 casas (`{ "amount": "25.00", "currency": "BRL" }`).

## Como trabalhar neste projeto

- **As decisões de arquitetura são do autor do projeto.** Ao chegar em um ponto de decisão, explique o conceito, as opções e os trade-offs, e pergunte. Não escolha nem recomende, a menos que seja pedido. Sinalize apenas quando uma opção violar uma restrição acima ou for cara de desfazer.
  - Exceção: ao usar a skill `grilling`, dar a resposta recomendada para cada pergunta é permitido.
- Toda decisão tomada é registrada no `ARCHITECTURE.md` (decisão, alternativas consideradas, por que, trade-offs).
- Mudanças pequenas e incrementais; uma etapa por vez.

## Testes

- Test runner: `bun test`.
- Testes de integração e concorrência usam **PostgreSQL e LocalStack reais** em containers. Nunca mockar banco ou fila nesses testes (isso complementa a skill `tdd`, que permite mockar banco "às vezes": aqui não).
- Testes de concorrência usam paralelismo real, não chamadas sequenciais.
- Todo teste que mexe em saldo verifica a invariante: `wallet.balance == saldo reconstruído pelo ledger`.
- Testes determinísticos: sem `sleep` fixo; esperar por condição (polling com timeout).

## Comandos

<!-- Preencher após o setup da etapa 1: subir ambiente, migrations, testes por tipo. -->
