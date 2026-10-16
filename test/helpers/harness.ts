import { randomUUID } from 'node:crypto';
import { Services, buildServices } from '../../src/composition';
import { loadConfig } from '../../src/config/config';
import { SilentLogger } from '../../src/infrastructure/observability/logger';
import { CountingMetrics } from '../../src/infrastructure/observability/metrics';
import { FakeClock } from '../../src/infrastructure/system/system';
import type { Clock } from '../../src/application/ports/ports';
import type { WagerResult } from '../../src/application/use-cases/process-wager-transaction';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/wager_test';

export interface Harness extends Services {
  metrics: CountingMetrics;
  logger: SilentLogger;
  fakeClock?: FakeClock;
  reset(): Promise<void>;
  close(): Promise<void>;
  sql<T = Record<string, any>>(query: string, params?: unknown[]): Promise<T[]>;
}

export async function createHarness(opts: { fakeClock?: boolean; env?: Record<string, string>; noReset?: boolean } = {}): Promise<Harness> {
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    DB_POOL_MAX: '30',
    REFERENCE_MAX_ATTEMPTS: '4',
    REFERENCE_BACKOFF_BASE_MS: '1000',
    REFERENCE_BACKOFF_CAP_MS: '8000',
    REFERENCE_TTL_MS: String(60 * 60_000),
    ...opts.env,
  });
  const fakeClock = opts.fakeClock ? new FakeClock(new Date()) : undefined;
  const metrics = new CountingMetrics();
  const logger = new SilentLogger();
  const clock: Clock | undefined = fakeClock;
  const services = await buildServices(config, { metrics, logger, ...(clock ? { clock } : {}) });
  await services.orm.getMigrator().up();

  const harness: Harness = {
    ...services,
    metrics,
    logger,
    ...(fakeClock ? { fakeClock } : {}),
    async reset() {
      await services.orm.em.execute(
        `TRUNCATE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages RESTART IDENTITY CASCADE`,
      );
    },
    async close() {
      await services.orm.close();
    },
    async sql(query, params = []) {
      return (await services.orm.em.fork().execute(query, params as any[])) as any[];
    },
  };
  if (!opts.noReset) await harness.reset();
  return harness;
}

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export async function newWallet(h: Harness, balance = '100.00', currency = 'BRL') {
  const playerId = randomUUID();
  const wallet = await h.createWallet.execute({ playerId, initialBalance: { amount: balance, currency } }, 'test');
  return { walletId: wallet.walletId, playerId };
}

type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export interface TxInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

let counter = 0;
export function txInput(
  w: { walletId: string; playerId: string },
  kind: Kind,
  amount: string,
  over: Partial<TxInput> = {},
): TxInput {
  counter += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${counter}-${randomUUID().slice(0, 8)}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    ...over,
  };
}

export const keyOf = (i: TxInput) => `${i.providerId}:${i.externalTransactionId}`;

export function submit(h: Harness, input: TxInput, key = keyOf(input), source: 'http' | 'sqs' = 'http'): Promise<WagerResult> {
  return h.processWager.execute(input, key, { correlationId: 'test', source });
}

export async function balanceOf(h: Harness, walletId: string): Promise<string> {
  const [row] = await h.sql<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [walletId]);
  return String(row!.balance);
}

export async function ledgerOf(h: Harness, walletId: string) {
  return h.sql('SELECT * FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq', [walletId]);
}

export async function eventTypes(h: Harness): Promise<string[]> {
  const rows = await h.sql<{ event_type: string }>('SELECT event_type FROM outbox_messages ORDER BY seq');
  return rows.map((r) => r.event_type);
}
