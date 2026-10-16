import type { MikroORM } from '@mikro-orm/postgresql';
import { DEFAULT_REFERENCE_POLICY, TransactionApplier } from './application/transaction-applier';
import type { AppLogger, Clock, EventPublisher, IdGenerator, Metrics } from './application/ports/ports';
import { CreateWallet } from './application/use-cases/create-wallet';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { PublishOutbox } from './application/use-cases/publish-outbox';
import { WalletQueries } from './application/use-cases/queries';
import { ReprocessPendingReferences } from './application/use-cases/reprocess-pending-references';
import type { AppConfig } from './config/config';
import { createOrm } from './infrastructure/persistence/orm';
import { PgReadModel } from './infrastructure/persistence/pg-repositories';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/unit-of-work';
import { PromMetrics } from './infrastructure/observability/metrics';
import { PinoAppLogger } from './infrastructure/observability/logger';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system';

export interface Services {
  config: AppConfig;
  orm: MikroORM;
  clock: Clock;
  ids: IdGenerator;
  metrics: Metrics;
  prom?: PromMetrics;
  logger: AppLogger;
  uow: MikroOrmUnitOfWork;
  reads: PgReadModel;
  applier: TransactionApplier;
  createWallet: CreateWallet;
  processWager: ProcessWagerTransaction;
  reprocessReferences: ReprocessPendingReferences;
  queries: WalletQueries;
  makeOutboxPublisher(publisher: EventPublisher): PublishOutbox;
}

export interface Overrides {
  clock?: Clock;
  ids?: IdGenerator;
  metrics?: Metrics;
  logger?: AppLogger;
  orm?: MikroORM;
}

/** Composition root único: produção (Nest) e testes montam o grafo de objetos exatamente do mesmo jeito. */
export async function buildServices(config: AppConfig, overrides: Overrides = {}): Promise<Services> {
  const orm = overrides.orm ?? (await createOrm(config));
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new UuidV7Generator();
  const prom = overrides.metrics ? undefined : new PromMetrics();
  const metrics: Metrics = overrides.metrics ?? prom!;
  const logger = overrides.logger ?? PinoAppLogger.create(config.LOG_LEVEL);

  const uow = new MikroOrmUnitOfWork(
    orm,
    { lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS, statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS },
    metrics,
  );
  const reads = new PgReadModel(orm.em.fork());
  const applier = new TransactionApplier(clock, ids, metrics, {
    ...DEFAULT_REFERENCE_POLICY,
    maxAttempts: config.REFERENCE_MAX_ATTEMPTS,
    backoff: { baseMs: config.REFERENCE_BACKOFF_BASE_MS, capMs: config.REFERENCE_BACKOFF_CAP_MS },
    ttlMs: config.REFERENCE_TTL_MS,
  });

  return {
    config,
    orm,
    clock,
    ids,
    metrics,
    ...(prom ? { prom } : {}),
    logger,
    uow,
    reads,
    applier,
    createWallet: new CreateWallet(uow, clock, ids),
    processWager: new ProcessWagerTransaction(uow, applier, clock, ids, metrics),
    reprocessReferences: new ReprocessPendingReferences(uow, applier, clock, ids, metrics),
    queries: new WalletQueries(reads, metrics, logger),
    makeOutboxPublisher: (publisher) =>
      new PublishOutbox(uow, publisher, clock, metrics, logger, {
        baseMs: config.OUTBOX_BACKOFF_BASE_MS,
        capMs: config.OUTBOX_BACKOFF_CAP_MS,
      }, config.OUTBOX_PUBLISH_CONCURRENCY),
  };
}
