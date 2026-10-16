# Wagering Processor

Processador de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com wallet, **ledger imutável**,
idempotência persistente, **inbox/outbox transacionais**, consumo de SQS FIFO e correção sob concorrência
(várias instâncias, retries e mensagens duplicadas ou fora de ordem).

Stack: **Bun · TypeScript (strict) · NestJS · MikroORM (PostgreSQL 16) · AWS SQS FIFO (MiniStack no Compose) · decimal.js · zod · pino · prom-client**.

> Decisões, trade-offs e limitações: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Subir tudo (Docker Compose)

```bash
docker compose up --build
```

Sobe PostgreSQL, SQS emulado (MiniStack), um job `migrate` (roda **uma vez**, antes da aplicação) e a API em `http://localhost:3000`.
As filas FIFO (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`) são criadas na inicialização.

## Rodar localmente (sem containerizar a aplicação)

```bash
docker compose up -d postgres sqs
bun install
cp .env.example .env            # ajuste se necessário
bun run migrate:up              # aplica as migrations
bun run start                   # API + consumer SQS + publisher da outbox + worker de referências
```

| Comando | O que faz |
|---|---|
| `bun run migrate:up` / `migrate:down` / `migrate:status` | migrations (reversíveis) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test test/unit` (`bun run test`) | testes de unidade (sem I/O) |
| `bun run test:integration` | integração/concorrência/processos reais — **requer PostgreSQL e SQS no ar** |
| `bun run test:all` | tudo |
| `bun run test:load` | teste de carga contra uma instância em execução (`BASE_URL`) |

Os testes de integração usam o banco `wager_test` e filas com nome aleatório por execução:
`TEST_DATABASE_URL` (padrão `postgres://postgres:postgres@127.0.0.1:5432/wager_test`) e
`TEST_SQS_ENDPOINT` (padrão `http://127.0.0.1:4566`). Crie o banco antes: `createdb wager_test`.

## API

Todas as respostas de erro seguem `{"error": {"code", "message", "retryable", "correlationId", "details?"}}`.

| Endpoint | Descrição |
|---|---|
| `POST /wallets` | cria wallet; saldo inicial > 0 gera `OPENING` + lançamento `CREDIT` na mesma transação SQL |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | ledger paginado, cursor opaco e estável |
| `POST /wagering/transactions` (`Idempotency-Key` obrigatório) | submete uma transação |
| `GET /wagering/transactions/:transactionId` | consulta por id |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `POST /wallets/:walletId/reconciliation` | recalcula o saldo pelo ledger e compara |
| `GET /health/live` · `GET /health/ready` · `GET /metrics` | liveness, readiness (PostgreSQL + SQS), Prometheus |

### Status HTTP (consistente em todos os endpoints)

| Situação | HTTP | Reenviar? |
|---|---|---|
| Aplicada (nova) / replay idempotente | `201` / `200` | — |
| Aceita, aguardando a transação referenciada (`PENDING_REFERENCE`) | `202` | não reenviar; o resultado é resolvido depois |
| Rejeitada por regra de negócio (`REJECTED` + `failureCode`) | `422` | não (terminal); a mesma key devolve a mesma rejeição |
| Payload inválido | `400` | não adianta: corrigir |
| Conflito de idempotência / wallet duplicada | `409` | não |
| Wallet/transação inexistente | `404` | não |
| Falha transitória de infraestrutura | `503` + `Retry-After` | **sim**, a mesma requisição com a mesma key |

### Exemplo

```bash
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"<uuid>","walletId":"<uuid>","roundId":"round-987","gameId":"fortune-chimp",
       "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

### Mensagem SQS (`wager-transactions.fifo`)

```json
{ "messageId": "msg-123", "type": "WagerTransactionRequested", "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123",
            "idempotencyKey": "provider-a:transaction-123", "playerId": "<uuid>", "walletId": "<uuid>",
            "roundId": "round-987", "gameId": "fortune-chimp", "kind": "BET",
            "money": { "amount": "25.00", "currency": "BRL" } } }
```

Sugestão ao produtor: `MessageGroupId = walletId`. Eventos publicados em `wager-events.fifo`:
`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WagerTransactionFailed`, `WalletBalanceChanged`.

## Home / painel de demonstração (extra)

Com a aplicação no ar, abra **`http://localhost:<porta>/`** (a Home) ou **`http://localhost:<porta>/demo`** — as duas URLs servem a mesma página
(no Compose a porta é a que `docker compose ps` mostra para o `app`).
É uma única página HTML, sem build, que chama a API real: tem três botões que rodam os cenários do desafio com requisições paralelas de verdade
(2 apostas de 80 contra saldo de 100, mesma aposta 50× em paralelo, `REFUND` antes da `BET`) e marcam ✓/✗ para cada invariante, uma "fita" de ledger
com saldo e reconciliação ao vivo, e uma bancada para criar wallets e enviar `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, reenvios e conflitos de idempotência.
**Não faz parte do escopo avaliado**: não toca em domínio nem em casos de uso (arquivo `demo/index.html` + `DemoController`).
Desligue com `ENABLE_DEMO=false` (`/` e `/demo` passam a responder 404).

## Interpretações adotadas

- **Reversão única no total:** uma transação só pode ser revertida **uma vez** por uma reversão `PROCESSED` (e não "uma vez por tipo"),
  o que impede `REFUND` + `ROLLBACK` da mesma `BET` creditando em dobro. Detalhes em `docs/ARCHITECTURE.md` §7.
- **Inbox:** mesmo `messageId` com corpo diferente é conflito (DLQ), não duplicata.
- **Várias instâncias:** `docker compose up --build --scale app=3` (portas 3000–3002 no host).
- **SQS local:** o Compose usa o **MiniStack** (`ministackorg/ministack`, porta 4566, uma das opções do desafio), o mesmo emulador usado nos testes de integração. O código fala com ele pelo SDK da AWS e funcionaria igual com LocalStack ou SQS real.

## Estrutura

```
src/
  domain/          Money, Wallet, WalletLedgerEntry, WagerTransaction, Inbox/Outbox, eventos — sem framework, sem I/O
  application/     use cases + portas (UnitOfWork, repositórios, Clock, EventPublisher, Metrics...)
  infrastructure/  PostgreSQL (MikroORM + SQL explícito), migrations, SQS, observabilidade
  presentation/    controllers NestJS, filtro de erros, guard de auth (ponto de extensão)
  composition.ts   composition root único (produção e testes montam o grafo igual)
test/              unit · integration (PostgreSQL/SQS/processos reais) · load
```

## Autenticação

Não implementada (seção 2 do desafio aceita). `AuthGuard` é um ponto de extensão explícito; o desenho proposto está no `ARCHITECTURE.md`.