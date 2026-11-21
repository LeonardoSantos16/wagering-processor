# Wagering Processor

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por HTTP e por SQS. Mantém saldo e ledger consistentes com várias instâncias, idempotência persistida no banco, inbox/outbox e reconciliação.

As decisões de arquitetura, os trade-offs e as limitações estão no [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose

## Setup

```bash
bun install
bun run infra:up      # PostgreSQL 17 + LocalStack 4.14.0 (SQS), espera ficarem saudáveis
bun run db:migrate    # aplica as migrations
```

O LocalStack cria as filas no boot (`docker/localstack/init-sqs.sh`):

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada de transações (redrive para a DLQ após 8 recebimentos) |
| `wager-transactions-dlq.fifo` | DLQ da entrada |
| `wagering-events.fifo` | eventos de integração publicados pela outbox |

Para reverter as migrations: `bun run db:migrate:down`. Para derrubar a infraestrutura e apagar os dados: `bun run infra:down`.

## Subindo a aplicação

Uma instância, na porta 3000:

```bash
bun run start         # ou bun run dev, com watch
```

Três instâncias, cada uma num terminal, no mesmo banco e nas mesmas filas. As migrations rodam uma vez antes, nunca no boot (ARCHITECTURE §1.1):

```bash
PORT=3001 bun run start
PORT=3002 bun run start
PORT=3003 bun run start
```

Cada instância roda a API, o consumidor SQS, o publisher da outbox e o worker de referências pendentes. Os três podem ser desligados por variável (tabela abaixo).

## Testes

Os testes de integração usam PostgreSQL e LocalStack reais: rode `bun run infra:up` e `bun run db:migrate` antes.

| O que | Comando |
|---|---|
| Tudo | `bun test` |
| Unidade (domínio e application, sem infraestrutura) | `bun test ./src` |
| Integração, concorrência e e2e | `bun test ./test` |
| Só concorrência | `bun test concurrency` |
| Falhas e múltiplas instâncias (processos separados, `SIGKILL`) | `bun test ./test/resilience` |
| Typecheck | `bun run typecheck` |

Os cenários cobertos por cada grupo estão no ARCHITECTURE §17.

## Exemplos de requisição

Os exemplos usam `curl` e [`jq`](https://jqlang.org). Valores monetários são sempre strings com 2 casas.

```bash
API=http://localhost:3000

# Criar uma wallet com saldo inicial
WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}')
WALLET_ID=$(echo $WALLET | jq -r .id)

# BET (201 PROCESSED, 422 REJECTED, 202 PENDING_REFERENCE)
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: key-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-1\",\"playerId\":\"player-1\",
       \"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",
       \"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

# Repetir o mesmo comando devolve a mesma resposta com "idempotentReplay": true.
# A mesma idempotency-key com outro payload responde 409 IDEMPOTENCY_CONFLICT.

# ROLLBACK da BET acima
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: key-2' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-2\",\"playerId\":\"player-1\",
       \"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",
       \"kind\":\"ROLLBACK\",\"referenceExternalTransactionId\":\"tx-1\",
       \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

# Consultas
curl -s $API/wallets/$WALLET_ID
curl -s "$API/wallets/$WALLET_ID/ledger?limit=10"   # paginado; próxima página com ?cursor=<nextCursor>
curl -s $API/providers/provider-a/wagering/transactions/tx-1
curl -s $API/wagering/transactions/<transactionId>

# Reconciliação (saldo gravado x saldo reconstruído pelo ledger)
curl -s -X POST $API/wallets/$WALLET_ID/reconciliation

# Health checks e métricas (abertos)
curl -s $API/health/live
curl -s $API/health/ready
curl -s $API/metrics
```

## Publicando uma mensagem de teste no SQS

A mensagem segue o envelope `WagerTransactionRequested` (ARCHITECTURE §12). O `MessageGroupId` é o `walletId`:

```bash
docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET_ID" \
  --message-deduplication-id msg-1 \
  --message-body "{\"messageId\":\"msg-1\",\"type\":\"WagerTransactionRequested\",
    \"occurredAt\":\"2026-01-01T00:00:00.000Z\",
    \"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-3\",\"idempotencyKey\":\"key-3\",
      \"playerId\":\"player-1\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",
      \"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"

# Resultado
curl -s http://localhost:3000/providers/provider-a/wagering/transactions/tx-3
```

Mensagens inválidas ou com conflito vão para `wager-transactions-dlq.fifo`. Para ler os eventos publicados pela outbox:

```bash
docker compose exec -T localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events.fifo \
  --max-number-of-messages 10 --message-attribute-names All
```

## Configuração

Tudo vem de variáveis de ambiente, validadas no boot. Os padrões apontam para o ambiente local, então nada precisa ser definido para rodar. A lista completa está no [`.env.example`](.env.example).

| Variável | Padrão | O que faz |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `LOG_LEVEL` | `info` | nível do log (JSON, pino) |
| `DB_HOST` / `DB_PORT` / `DB_NAME` | `localhost` / `5432` / `wagering` | PostgreSQL |
| `WALLET_LOCK_TIMEOUT_MS` | `2000` | espera máxima pelo lock da wallet (depois, 503) |
| `AWS_ENDPOINT` | `http://localhost:4566` | LocalStack |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumidor da fila de entrada |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | liga o publisher da outbox |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga o worker de referências pendentes |
| `PENDING_REFERENCE_TTL_MS` | `3600000` | prazo para a referência chegar (1 h) |

## Comandos

| Comando | O que faz |
|---|---|
| `bun run infra:up` / `infra:down` | sobe / derruba PostgreSQL e LocalStack (o `down` apaga os volumes) |
| `bun run db:migrate` / `db:migrate:down` | aplica / reverte migrations |
| `bun run db:migration:create` | gera migration a partir das entidades |
| `bun run start` / `dev` | sobe a API sem / com watch |
| `bun test` | roda os testes |
| `bun run typecheck` | typecheck em modo estrito |
