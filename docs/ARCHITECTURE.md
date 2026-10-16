# Arquitetura, decisões, trade-offs e limitações

## 1. Visão geral

```
 Provedor ──HTTP──▶ ┌────────────────────────────┐          ┌──────────────┐
                    │  API (NestJS)              │          │ PostgreSQL   │
 Provedor ──SQS───▶ │  Consumer SQS ─┐           │  1 tx    │  wallets     │
   (FIFO)           │                ▼           │ ───────▶ │  wager_tx    │
                    │   ProcessWagerTransaction  │  commit  │  ledger      │
                    │   (MESMO use case)         │          │  inbox       │
                    ├────────────────────────────┤          │  outbox      │
                    │ Worker referências ─┐      │ ◀─────── └──────────────┘
                    │ Publisher outbox ───┴──────┼──▶ SQS (eventos)
                    └────────────────────────────┘
```

Toda instância roda os mesmos componentes (liga/desliga por variável de ambiente). **Não há estado em memória que importe
para a correção**: qualquer instância pode morrer a qualquer momento e outra continua o trabalho.

**Camadas** (dependências sempre para dentro): `domain` (sem framework, sem I/O) ← `application` (use cases + portas)
← `infrastructure` / `presentation`. `composition.ts` é o único lugar que conhece todas as peças.

## 2. Modelo de domínio

* **`Money`** — value object imutável sobre `decimal.js` (**nunca `number`**). Entrada: inteiro ou até 2 casas, sem sinal,
  sem notação científica, até 17 dígitos inteiros (`numeric(19,2)`). Saída: sempre string com 2 casas. Aritmética exata
  (`0.10 + 0.20 === 0.30`). Moedas diferentes lançam `CurrencyMismatchError` em toda operação.
* **`Wallet`** (aggregate root) — `debit`/`credit` devolvem o `WalletLedgerEntry` correspondente: **saldo e ledger só mudam
  juntos**. Saldo nunca fica negativo; em caso de falha o estado não é alterado. `version` sobe 1 a cada mudança de saldo.
* **`WalletLedgerEntry`** — imutável (campos `readonly`, sem métodos de transição); `create` valida a aritmética
  `before ± amount = after`. `rehydrate` só reconstrói o já persistido.
* **`WagerTransaction`** — máquina de estados:

```
PENDING ──▶ PROCESSED | REJECTED | FAILED
   └─────▶ PENDING_REFERENCE ──▶ PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
(PROCESSED, REJECTED e FAILED são terminais: qualquer transição lança InvalidTransactionStateError)
```

  `PENDING` só existe **dentro** da transação de banco (nunca é visível para outras conexões). O domínio também decide a
  *direção* do lançamento (`ROLLBACK` = inverso da referência) e avalia referências (`evaluateReference`).
* **Eventos** — classe abstrata `IntegrationEvent<T>` com uma subclasse por evento (`eventType` e `version` no tipo).
  `data` carrega `MoneyProps` (string decimal), nunca a instância de `Money`.

## 3. Fluxo de uma transação (`ProcessWagerTransaction`)

Tudo abaixo ocorre em **uma única transação PostgreSQL** (READ COMMITTED):

1. Valida o payload (zod `strict`) e `Money`; calcula o `payloadHash`.
2. **Inbox** (só SQS): `INSERT … ON CONFLICT DO NOTHING (consumer, messageId)`. Se já existia → duplicata de mensagem, devolve o resultado original.
3. **Idempotência de negócio**: procura por `idempotencyKey` (e por `provider + externalTransactionId`). Achou → replay (mesmo hash) ou conflito.
4. Confere que a wallet existe (leitura sem lock).
5. `INSERT … ON CONFLICT DO NOTHING` da transação (reserva a chave). Perdedor de corrida bloqueia no índice único até o commit/rollback do vencedor e cai no ramo de replay.
6. **`SELECT … FOR NO KEY UPDATE`** na wallet (serializa por wallet).
7. `TransactionApplier`: regras de negócio → saldo → ledger → estado final → eventos na **outbox**.
8. Marca o inbox como processado. **COMMIT.** Só depois disso o consumer faz `DeleteMessage` (ack).

Falha de **negócio** vira estado terminal `REJECTED` (commit, auditável). Falha de **infraestrutura** propaga como exceção:
rollback de tudo (saldo, ledger, transação, inbox, outbox) e retry seguro.

## 4. Garantias no schema (não só no código)

| Garantia | Mecanismo no PostgreSQL |
|---|---|
| Saldo ≥ 0 | `CHECK (balance >= 0)` |
| Uma wallet por (player, moeda) | `UNIQUE (player_id, currency)` |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Ledger imutável | trigger `BEFORE UPDATE OR DELETE` → exceção |
| Aritmética do lançamento | `CHECK` (`CREDIT`: after = before + amount; `DEBIT`: after = before − amount), `amount > 0` |
| Cadeia contínua do ledger | trigger `BEFORE INSERT`: `balance_before` = `balance_after` do lançamento anterior da wallet |
| **Saldo só muda com lançamento** | *constraint trigger* `DEFERRABLE INITIALLY DEFERRED`: no COMMIT, `wallets.balance` = último `balance_after` |
| `version` só sobe se o saldo mudar | trigger em `wallets` (e identidade da wallet imutável) |
| Estado terminal imutável; transações nunca apagadas; colunas de identidade/negócio imutáveis (provider, ids, wallet, player, round, game, kind, valor, moeda, referência, `created_at`) | trigger em `wager_transactions` |
| 1 lançamento por (wallet, transação) | `UNIQUE (wallet_id, transaction_id)` |
| Reversão única de uma referência | índice único parcial em `reference_transaction_id` (`status='PROCESSED'` e `kind IN ('REFUND','ROLLBACK')`) |
| Regras por tipo (REFUND/ROLLBACK exigem referência; BET não tem; `OPENING` só interno) | `CHECK`s |

As principais (saldo negativo, ledger append-only, saldo sem lançamento, cadeia quebrada, `version`, chaves duplicadas, estado terminal, regras por tipo) foram exercitadas diretamente por SQL e pelos testes de integração. O índice único parcial de reversão é uma rede de segurança: nos testes de concorrência a regra de negócio (`ALREADY_REVERSED`) responde antes de ele ser atingido.

## 5. Concorrência

* **Lock por wallet**, nunca global: wallets diferentes processam em paralelo (teste: uma wallet travada por outra transação não atrasa a outra).
* **`FOR NO KEY UPDATE`, não `FOR UPDATE` — achado por teste.** Inserir em `wager_transactions`/`wallet_ledger_entries`
  toma `FOR KEY SHARE` na wallet (por causa das FKs). Com `FOR UPDATE`, duas transações da *mesma* wallet ficavam cada uma com
  `KEY SHARE` e depois cada uma esperava a outra → **deadlock** (`40P01`), reproduzido pelo teste "50 BETs disputando saldo".
  `NO KEY UPDATE` continua serializando quem altera a wallet e é compatível com `KEY SHARE`. Depois da correção, o teste de carga
  com 6 wallets + workers rodando em paralelo mede **0** deadlocks/lock timeouts.
* **Ordem de locks única** (linha da transação → wallet) em todos os caminhos. O worker de referências processa **uma
  transação por transação de banco** para nunca segurar dois locks de wallet ao mesmo tempo.
* `version` + `UPDATE … WHERE version = ?` como defesa em profundidade (não deveria falhar sob o lock; se falhar vira erro transitório).
* `lock_timeout` e `statement_timeout` por transação: contenção extrema falha rápido (transitório) em vez de pendurar conexões.
* **Hot wallet**: operações da mesma wallet são, por desenho, sequenciais. O ganho de paralelismo está entre wallets. É o limite
  de vazão de uma única wallet (trade-off assumido: correção > throughput por wallet).

## 6. Idempotência

* `Idempotency-Key` (HTTP) / `data.idempotencyKey` (SQS) é a **fonte da verdade**; padrão recomendado `{providerId}:{externalTransactionId}`.
* **`payloadHash`** = SHA-256 do **JSON canônico** (chaves ordenadas recursivamente, `undefined` omitido) de:
  `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount normalizado a 2 casas, currency},
  referenceExternalTransactionId`. Header e metadados de transporte **não** entram. Por isso `"25"` e `"25.00"` são o mesmo payload.
* Mesma key + mesmo hash → resposta **original**, `idempotentReplay: true` (inclusive o **saldo observado na época**, guardado
  em `result_balance`; replay de `REJECTED` devolve a mesma rejeição).
* Mesma key + hash diferente, ou mesmo `externalTransactionId` com outra key → `IdempotencyConflictError` (409), **não** replay.
* Persistente e baseada em índice único: vale entre instâncias e sobrevive a reinício.

## 7. Referências fora de ordem

`REFUND`/`ROLLBACK` (obrigatório) e `WIN`/`LOSS` (se informada) cuja referência ainda não existe viram `PENDING_REFERENCE`
(HTTP `202`, evento `WagerTransactionPendingReference` uma vez). Um worker reavalia quando `next_attempt_at` vence
(`FOR UPDATE SKIP LOCKED`), com backoff exponencial. Padrões: 8 tentativas, base 5 s, teto 300 s, TTL 30 min.
Esgotado → `REJECTED / REFERENCE_NOT_FOUND`. Referência que existe mas terminou `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`.
Uma transação pendente **nunca altera o saldo** enquanto não for resolvida.

**Interpretação adotada para reversões:** uma transação só pode ser revertida **uma vez no total** por uma reversão
`PROCESSED` (e não "uma vez por tipo"). É estritamente mais seguro: impede `REFUND` + `ROLLBACK` da mesma `BET` creditando em dobro.
`ROLLBACK` de um `REFUND` é permitido (é outra referência). Reversão exige valor idêntico ao da referência, mesmo provedor,
player, wallet, moeda e rodada. Reversão que deixaria o saldo negativo → `REVERSAL_INSUFFICIENT_FUNDS`
(código distinto de `INSUFFICIENT_FUNDS`, porque a causa e a ação do provedor são outras).

### Códigos de falha (`failureCode`) e orientação ao provedor

| Código | Significado | Orientação |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | nova transação quando houver saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão deixaria saldo negativo | contatar suporte |
| `REFERENCE_NOT_FOUND` | referência nunca apareceu (TTL/tentativas) | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | referência foi `REJECTED`/`FAILED` | não reenviar |
| `REFERENCE_MISMATCH` | referência de outro provedor/player/wallet/moeda/rodada | corrigir payload |
| `REFERENCE_KIND_INVALID` | tipo de referência inválido (ex.: `REFUND` de `WIN`) | corrigir payload |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência | corrigir payload |
| `ALREADY_REVERSED` | referência já revertida | não reenviar |
| `CURRENCY_MISMATCH` / `PLAYER_MISMATCH` | moeda/player ≠ da wallet | corrigir payload |
| `INTERNAL_ERROR` | `FAILED`: retries esgotados por erro de infraestrutura | contatar suporte |

## 8. Mensageria

**Consumer SQS** (reutiliza o mesmo use case da HTTP; `ack` só depois do commit):

| Resultado | Ação |
|---|---|
| Aplicada, `REJECTED`, `PENDING_REFERENCE`, duplicata, replay | ack (resultado estável e terminal) |
| JSON inválido, envelope inválido, payload inválido, conflito de idempotência, wallet inexistente | **DLQ imediata** (`reason` no atributo da mensagem) |
| Transitório ou inesperado (banco fora, lock timeout, deadlock) | **sem ack**; `ChangeMessageVisibility` com backoff exponencial; após `SQS_MAX_RECEIVE_COUNT` → grava `FAILED` (melhor esforço) + DLQ |

* **Inbox** `(consumerName, messageId)` na **mesma transação** do efeito: se o processo morre depois do commit e antes do ack,
  a redelivery cai no inbox e é absorvida (teste com processo real morto por `exit(137)` entre commit e ack).
* Mesmo `messageId` com **corpo diferente** (hash ≠ o gravado no inbox) → `IdempotencyConflictError` → DLQ; não é tratado como duplicata.
* Mesmo `messageId` novo + mesma `idempotencyKey` (reenvio do provedor) → replay pela idempotência de negócio.
* **FIFO é otimização, não garantia**: `MessageGroupId = walletId` melhora a ordem, mas a correção vem do banco. Mensagens de
  grupos diferentes de um lote rodam em paralelo; dentro do grupo, em ordem.
* **Shutdown**: `SIGTERM`/`SIGINT` → para de receber, conclui o lote em andamento, workers terminam a iteração, fecha o pool, sai com código 0
  (timeout de segurança de 25 s). `stop_grace_period: 30s` no Compose.

## 9. Transactional Outbox

Eventos são gravados na **mesma transação** do efeito (nunca publicados antes do commit). O publisher lê
`WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now) ORDER BY seq FOR UPDATE SKIP LOCKED`:
vários publishers concorrentes não pegam a mesma linha. Falha ao publicar → `attempts++`, backoff exponencial em `next_attempt_at`, `last_error`.

* **Entrega at-least-once.** Se o processo morrer depois de publicar e antes do commit do `published_at`, o evento sai de novo —
  com o **mesmo `eventId`** (= id da linha da outbox), que o consumidor usa para deduplicar. `MessageDeduplicationId = eventId` no FIFO.
* Ordem **não** é garantida entre retries; os eventos carregam `occurredAt` e `walletVersion` para o consumidor ordenar.
* `WalletBalanceChanged` só é emitido quando o saldo muda (não em `LOSS`, não em rejeições). `OPENING` emite apenas `WalletBalanceChanged`.

## 10. HTTP: mapeamento único de status

Ver a tabela no README. Princípio: o provedor decide reenviar **só pelo status**. `400` (corrigir) ≠ `409` (conflito) ≠ `422` (negócio, terminal)
≠ `202` (pendente) ≠ `503` (transitório, reenviar a mesma requisição). Erros têm formato único com `code`, `retryable` e `correlationId`.

## 11. Observabilidade

* **Logs JSON** (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. **Nunca** logam valores
  financeiros nem corpos de requisição.
* **Métricas** (`/metrics`): `wager_transactions_total{status,kind}`, `wager_duplicates_total{source}`,
  `wager_idempotency_conflicts_total`, `wager_retries_total{source}`, `wager_dlq_total{reason}`, `wager_lock_contention_total`,
  `wager_processing_seconds{source}`, `wager_outbox_pending`, `wager_outbox_oldest_age_seconds` (lag), `wager_outbox_published_total`,
  `wager_reconciliation_divergence_total`.
* **Health**: `/health/live` (não toca dependências) e `/health/ready` (PostgreSQL e SQS). Sem autenticação.
* **Reconciliação**: uma única instrução SQL (snapshot consistente) compara saldo × soma do ledger. Divergência **não é
  corrigida**: log de erro + métrica + `consistent:false` na resposta.

## 12. Autenticação (decisão: não implementada)

A seção 2 do desafio aceita não implementar. Para não competir com correção financeira, deixei um `AuthGuard` **no-op** como
ponto de extensão (health e métricas marcados `@Public()`). Desenho que adotaria: **Keycloak (OIDC)** como IdP; o guard validaria o JWT
(assinatura via JWKS, `iss`, `aud`, `exp`) e extrairia a identidade do provedor de um claim (client credentials), que seria
comparada com `providerId` do corpo — um provedor só opera em nome de si mesmo. Mensagens SQS são canal interno confiável, mas o
`providerId` continua sujeito às validações de domínio.

## 13. Testes (156)

* **Unidade (84)** — `Money`, `Wallet`, ledger, máquina de estados, regras de referência, backoff, outbox/inbox/eventos.
* **Integração com PostgreSQL e SQS reais** — constraints e triggers, atomicidade (falha no meio ⇒ rollback de tudo), inbox e redelivery,
  publishers concorrentes, retry/DLQ, reconciliação (inclusive divergência induzida), reprocessamento de referências com relógio controlável.
* **Concorrência (paralelismo real)** — 50 apostas iguais em paralelo ⇒ um débito; disputa de saldo; wallets distintas; 4 "instâncias" (pools independentes);
  mix aleatório de operações; 20 `REFUND` da mesma `BET`; ausência de deadlock.
* **Processos reais do SO** (`Bun.spawn`) — **3 processos** simultâneos; processo **morto (`exit 137`) depois do commit e antes do ack**;
  processo morto antes de publicar + 2 publishers assumindo; `SIGKILL` + `SIGTERM` + reinício no meio da carga.
* **Invariante final em todos os cenários:** `wallet.balance == saldo reconstruído pelo ledger` (e cadeia contínua, nunca negativo).

**SQS nos testes:** os testes de integração rodam contra o **MiniStack** (emulador de AWS compatível com LocalStack, com SQS FIFO, deduplicação e DLQ) em
`TEST_SQS_ENDPOINT` (padrão `http://127.0.0.1:4566`), e o mesmo emulador é usado no `docker-compose.yml`. O código usa apenas o SDK da AWS por HTTP; trocar por LocalStack
ou SQS real exige apenas mudar `AWS_ENDPOINT_URL`. Suíte de integração/concorrência (72 testes) validada contra o MiniStack 1.5.28 + PostgreSQL 16.

## 14. Teste de carga (`bun run test:load`)

* **Ambiente:** sandbox de **1 vCPU** compartilhado entre app, PostgreSQL 16 (`fsync=off`), SQS emulado (moto, Python; medição feita antes da troca para o MiniStack — os números podem variar) e o gerador de carga.
  Isto **não** é um benchmark representativo.
* **Metodologia:** 20 wallets (saldo 1000.00), 2000 requisições `BET`/`WIN` distribuídas por wallet, concorrência 50, chaves de idempotência distintas.
* **Resultados:** sem workers: 108 req/s, p50 443 ms, p95 670 ms, p99 1032 ms. Com consumer + publisher + worker ligados: ~62–68 req/s, p50 ~730–770 ms, p95 ~1,0–1,1 s, p99 ~1,2–1,4 s.
  Taxa de erro 0% (2000 × `201`). Conflitos de concorrência: `wager_lock_contention_total = 0`. Reconciliação: 20/20 wallets consistentes.
* **Outbox lag:** sob carga sustentada o backlog **cresceu** (≈3,5 mil pendentes, evento mais antigo ≈ 28–32 s ao fim da carga). Diagnóstico isolado:
  o caminho do banco publica **~1.570 eventos/s** (publisher fictício), mas o envio ao SQS emulado degrada de ~12 ms para ~104 ms por mensagem conforme a fila enche.
  Ou seja, o gargalo foi o emulador numa única CPU, não o desenho da outbox — **mas** em produção o teto passaria a ser o limite do SQS FIFO por chamada
  (a melhoria natural é `SendMessageBatch`, ver limitações).

## 15. Trade-offs e limitações conhecidas

1. **MikroORM com SQL explícito.** Pool, transações (`EntityManager.transactional`) e migrations usam o MikroORM, mas as instruções críticas
   (`INSERT … ON CONFLICT`, `FOR NO KEY UPDATE`, `FOR UPDATE SKIP LOCKED`, `UPDATE … WHERE version`) são SQL explícito via `em.execute` **dentro** da
   transação do ORM. Motivo: o Unit of Work/identity map não expressa essas instruções, e esconder o lock atrás de uma abstração tornaria o
   argumento de correção mais difícil de auditar. Custo: mapeamento linha↔domínio manual nos repositórios.
2. **Publisher mantém uma transação aberta durante o envio ao broker** (para reter o lock `SKIP LOCKED`). Lotes pequenos e `statement_timeout`
   limitam o impacto; alternativa seria *lease* por coluna (`locked_until`), que não adotei por simplicidade.
3. **Publicação sem `SendMessageBatch`:** um `SendMessage` por evento (com concorrência limitada de 10). Em produção, o limite do SQS FIFO por chamada seria o teto.
4. **Ordem de eventos não é garantida** entre retries da outbox (consumidor deve deduplicar por `eventId` e ordenar por `walletVersion`/`occurredAt`).
5. **`FAILED` é terminal:** se uma mensagem esgota retries por falha de infraestrutura e vai para a DLQ, um *redrive* com a mesma `idempotencyKey` devolve `FAILED`.
   Reprocessar exige procedimento operacional (nova key). Escolhi auditabilidade a reprocessamento automático.
6. **Wallet inexistente via SQS vai para a DLQ** (não é possível persistir a transação por causa da FK); via HTTP é `404`.
7. **TTL de referência:** uma referência que chega depois do esgotamento já encontra a transação pendente `REJECTED`; o provedor precisa reenviar com nova key.
8. **Hot wallet:** serialização por wallet limita a vazão de uma única wallet (ver §5).
9. **Relógio da aplicação** decide `next_attempt_at`; skew entre instâncias apenas antecipa/atrasa tentativas, sem afetar a correção.
10. **Home `/` e painel `/demo`** (extra, fora do escopo; mesma página nas duas URLs): página estática que só consome a API pública; `ENABLE_DEMO=false` a remove. Não é uma superfície de produção.
11. **Sem autenticação** (ver §12), **sem OpenTelemetry**, sem rotação de segredos: fora do escopo.
