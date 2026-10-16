import type { EntityManager } from '@mikro-orm/postgresql';
import {
  ConcurrentModificationError,
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  ReadModel,
  ReconciliationRow,
  TransactionContext,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/ports';
import { InboxMessage } from '../../domain/inbox-message';
import { WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { FailureCode } from '../../domain/failure-code';
import type { LedgerDirection } from '../../domain/ledger-entry';

type Exec = Pick<EntityManager, 'execute'>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function query(db: Exec, sql: string, params: unknown[] = []): Promise<Row[]> {
  const rows = await db.execute(sql, params.map((p) => (p === undefined ? null : p)));
  return rows as Row[];
}

const iso = (d: Date | undefined): Date | null => d ?? null;
const toDate = (v: unknown): Date | undefined => (v === null || v === undefined ? undefined : new Date(v as string | Date));

// ------------------------------------------------------------------ mappers
function toWallet(r: Row): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balance: Money.fromStored(String(r.balance), r.currency),
    version: Number(r.version),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  });
}

function toTransaction(r: Row): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: String(r.payload_hash).trim(),
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind as WagerTransactionKind,
    money: Money.fromStored(String(r.amount), r.currency),
    referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
    createdAt: new Date(r.created_at),
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.reference_transaction_id ?? undefined,
    failureCode: (r.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: toDate(r.processed_at),
    resultBalance: r.result_balance === null ? undefined : Money.fromStored(String(r.result_balance), r.currency),
    referenceAttempts: Number(r.reference_attempts),
    nextAttemptAt: toDate(r.next_attempt_at),
  });
}

function toOutbox(r: Row): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregate_id,
    eventType: r.event_type,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    occurredAt: new Date(r.occurred_at),
    attempts: Number(r.attempts),
    nextAttemptAt: toDate(r.next_attempt_at),
    publishedAt: toDate(r.published_at),
  });
}

// ------------------------------------------------------------------ wallets
const WALLET_COLS = 'id, player_id, currency, balance, version, created_at, updated_at';

export class PgWalletRepository implements WalletRepository {
  constructor(private readonly db: Exec) {}

  async insert(w: Wallet): Promise<boolean> {
    const rows = await query(
      this.db,
      `INSERT INTO wallets (${WALLET_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING id`,
      [w.id, w.playerId, w.currency, w.balance.amount, w.version, w.createdAt, w.updatedAt],
    );
    return rows.length === 1;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const [row] = await query(this.db, `SELECT ${WALLET_COLS} FROM wallets WHERE id = ?`, [id]);
    return row ? toWallet(row) : undefined;
  }

  /**
   * FOR NO KEY UPDATE (e não FOR UPDATE) é DELIBERADO. Inserir em wager_transactions / wallet_ledger_entries
   * toma FOR KEY SHARE na wallet (por causa da FK). Com FOR UPDATE, duas transações da mesma wallet ficam
   * cada uma com KEY SHARE e depois uma espera a outra => deadlock (achado pelo teste de concorrência).
   * NO KEY UPDATE continua serializando quem altera a wallet, mas é compatível com KEY SHARE.
   */
  async lockById(id: string): Promise<Wallet | undefined> {
    const [row] = await query(this.db, `SELECT ${WALLET_COLS} FROM wallets WHERE id = ? FOR NO KEY UPDATE`, [id]);
    return row ? toWallet(row) : undefined;
  }

  async save(w: Wallet, expectedVersion: number): Promise<void> {
    const rows = await query(
      this.db,
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ? RETURNING id`,
      [w.balance.amount, w.version, w.updatedAt, w.id, expectedVersion],
    );
    if (rows.length !== 1) {
      throw new ConcurrentModificationError(`wallet ${w.id} was modified concurrently (expected version ${expectedVersion})`);
    }
  }
}

// ------------------------------------------------------------------ transactions
const TX_COLS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status,
  failure_code, result_balance, reference_attempts, next_attempt_at, created_at, processed_at`;

export class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly db: Exec) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    const rows = await query(
      this.db,
      `INSERT INTO wager_transactions (${TX_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash, tx.walletId, tx.playerId,
        tx.roundId, tx.gameId, tx.kind, tx.money.amount, tx.money.currency, tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null, tx.status, tx.failureCode ?? null, tx.resultBalance?.amount ?? null,
        tx.referenceAttempts, iso(tx.nextAttemptAt), tx.createdAt, iso(tx.processedAt),
      ],
    );
    return rows.length === 1;
  }

  private async one(where: string, params: unknown[]): Promise<WagerTransaction | undefined> {
    const [row] = await query(this.db, `SELECT ${TX_COLS} FROM wager_transactions WHERE ${where}`, params);
    return row ? toTransaction(row) : undefined;
  }

  findById(id: string) {
    return this.one('id = ?', [id]);
  }
  findByIdempotencyKey(key: string) {
    return this.one('idempotency_key = ?', [key]);
  }
  findByProviderExternalId(providerId: string, externalTransactionId: string) {
    return this.one('provider_id = ? AND external_transaction_id = ?', [providerId, externalTransactionId]);
  }

  async update(tx: WagerTransaction): Promise<void> {
    const rows = await query(
      this.db,
      `UPDATE wager_transactions
          SET status = ?, failure_code = ?, result_balance = ?, reference_transaction_id = ?,
              processed_at = ?, reference_attempts = ?, next_attempt_at = ?
        WHERE id = ? RETURNING id`,
      [
        tx.status, tx.failureCode ?? null, tx.resultBalance?.amount ?? null, tx.referenceTransactionId ?? null,
        iso(tx.processedAt), tx.referenceAttempts, iso(tx.nextAttemptAt), tx.id,
      ],
    );
    if (rows.length !== 1) throw new ConcurrentModificationError(`transaction ${tx.id} not found for update`);
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const rows = await query(
      this.db,
      `SELECT 1 AS found FROM wager_transactions
        WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async claimDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = await query(
      this.db,
      `SELECT ${TX_COLS} FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
        ORDER BY next_attempt_at LIMIT ? FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toTransaction);
  }
}

// ------------------------------------------------------------------ ledger
export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Exec) {}

  async insert(e: WalletLedgerEntry): Promise<void> {
    await query(
      this.db,
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.id, e.walletId, e.transactionId, e.direction, e.money.amount, e.money.currency,
        e.balanceBefore.amount, e.balanceAfter.amount, e.createdAt,
      ],
    );
  }
}

// ------------------------------------------------------------------ inbox
export class PgInboxRepository implements InboxRepository {
  constructor(private readonly db: Exec) {}

  async tryReceive(m: InboxMessage): Promise<boolean> {
    const rows = await query(
      this.db,
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (consumer_name, message_id) DO NOTHING RETURNING message_id`,
      [m.consumerName, m.messageId, m.payloadHash, m.receivedAt, iso(m.processedAt)],
    );
    return rows.length === 1;
  }

  async payloadHashOf(consumerName: string, messageId: string): Promise<string | undefined> {
    const [row] = await query(
      this.db,
      `SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
    return row ? String(row.payload_hash).trim() : undefined;
  }

  async markProcessed(m: InboxMessage): Promise<void> {
    await query(this.db, `UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?`, [
      iso(m.processedAt),
      m.consumerName,
      m.messageId,
    ]);
  }
}

// ------------------------------------------------------------------ outbox
export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly db: Exec) {}

  async add(m: OutboxMessage): Promise<void> {
    await query(
      this.db,
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, ?, ?::jsonb, ?, ?, ?, ?)`,
      [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, iso(m.nextAttemptAt), iso(m.publishedAt)],
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await query(
      this.db,
      `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
         FROM outbox_messages
        WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY seq LIMIT ? FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toOutbox);
  }

  async save(m: OutboxMessage, lastError?: string): Promise<void> {
    await query(
      this.db,
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, published_at = ?, last_error = COALESCE(?, last_error)
        WHERE id = ?`,
      [m.attempts, iso(m.nextAttemptAt), iso(m.publishedAt), lastError ?? null, m.id],
    );
  }
}

// ------------------------------------------------------------------ leitura
export class PgReadModel implements ReadModel {
  private readonly wallets: PgWalletRepository;
  private readonly transactions: PgWagerTransactionRepository;

  constructor(private readonly db: Exec) {
    this.wallets = new PgWalletRepository(db);
    this.transactions = new PgWagerTransactionRepository(db);
  }

  findWallet(id: string) {
    return this.wallets.findById(id);
  }
  findTransaction(id: string) {
    return this.transactions.findById(id);
  }
  findTransactionByExternal(providerId: string, externalTransactionId: string) {
    return this.transactions.findByProviderExternalId(providerId, externalTransactionId);
  }

  async listLedger(walletId: string, afterSeq: number, limit: number): Promise<LedgerPage> {
    const rows = await query(
      this.db,
      `SELECT seq, id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
         FROM wallet_ledger_entries WHERE wallet_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      [walletId, afterSeq, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        seq: Number(r.seq),
        id: r.id,
        walletId: r.wallet_id,
        transactionId: r.transaction_id,
        direction: r.direction as LedgerDirection,
        amount: String(r.amount),
        currency: r.currency,
        balanceBefore: String(r.balance_before),
        balanceAfter: String(r.balance_after),
        createdAt: new Date(r.created_at),
      })),
      nextAfterSeq: hasMore ? Number(page[page.length - 1]!.seq) : undefined,
    };
  }

  async reconcile(walletId: string): Promise<ReconciliationRow | undefined> {
    // UMA instrução => um único snapshot: saldo e soma do ledger enxergam o mesmo instante.
    const [row] = await query(
      this.db,
      `SELECT w.currency AS currency, w.balance AS wallet_balance,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS ledger_balance,
              COUNT(l.id)::int AS entries
         FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    if (!row) return undefined;
    return {
      currency: row.currency,
      walletBalance: String(row.wallet_balance),
      ledgerBalance: String(row.ledger_balance),
      entries: Number(row.entries),
    };
  }

  async outboxStats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const [row] = await query(
      this.db,
      `SELECT COUNT(*)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM (?::timestamptz - MIN(occurred_at))), 0)::float AS age
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    return { pending: Number(row?.pending ?? 0), oldestAgeSeconds: Math.max(0, Number(row?.age ?? 0)) };
  }

  async ping(): Promise<void> {
    await query(this.db, 'SELECT 1');
  }
}

export function buildTransactionContext(db: Exec): TransactionContext {
  return {
    wallets: new PgWalletRepository(db),
    transactions: new PgWagerTransactionRepository(db),
    ledger: new PgLedgerRepository(db),
    inbox: new PgInboxRepository(db),
    outbox: new PgOutboxRepository(db),
  };
}
