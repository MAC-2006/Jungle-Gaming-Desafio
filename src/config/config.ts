import { z } from 'zod';

const int = (def: number) => z.coerce.number().int().positive().default(def);
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(3000),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/wager'),
  DB_POOL_MAX: int(10),
  DB_LOCK_TIMEOUT_MS: int(5_000),
  DB_STATEMENT_TIMEOUT_MS: int(15_000),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_WAGER_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wager-events.fifo'),
  SQS_AUTO_CREATE: bool(true),
  SQS_VISIBILITY_TIMEOUT_S: int(30),
  SQS_WAIT_TIME_S: z.coerce.number().int().min(0).max(20).default(2),
  SQS_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  /** Quantas vezes uma mensagem pode ser recebida antes de ir para a DLQ. */
  SQS_MAX_RECEIVE_COUNT: int(5),
  SQS_RETRY_BASE_S: int(2),
  SQS_RETRY_CAP_S: int(60),

  ENABLE_WORKERS: bool(true),
  ENABLE_SQS_CONSUMER: bool(true),
  ENABLE_OUTBOX_PUBLISHER: bool(true),
  ENABLE_REFERENCE_WORKER: bool(true),

  OUTBOX_POLL_INTERVAL_MS: int(500),
  OUTBOX_BATCH_SIZE: int(50),
  OUTBOX_PUBLISH_CONCURRENCY: int(10),
  OUTBOX_BACKOFF_BASE_MS: int(1_000),
  OUTBOX_BACKOFF_CAP_MS: int(60_000),

  REFERENCE_POLL_INTERVAL_MS: int(1_000),
  REFERENCE_BATCH_SIZE: int(50),
  REFERENCE_MAX_ATTEMPTS: int(8),
  REFERENCE_BACKOFF_BASE_MS: int(5_000),
  REFERENCE_BACKOFF_CAP_MS: int(300_000),
  REFERENCE_TTL_MS: int(30 * 60_000),

  /** Painel de demonstração em /demo (extra fora do escopo do desafio). Desligue em produção. */
  ENABLE_DEMO: bool(true),

  /** Somente para testes de falha (derruba o processo entre commit e ack). Nunca habilitar em produção. */
  ENABLE_FAULT_INJECTION: bool(false),
  /** Com fault injection: se o arquivo NÃO existir, cria e derruba o processo após o commit e antes do ack. */
  FAULT_CRASH_AFTER_COMMIT_FILE: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  return parsed.data;
}

export const CONFIG = Symbol('CONFIG');
