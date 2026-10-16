import type { InboxMessage } from '../../domain/inbox-message';
import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { Wallet } from '../../domain/wallet';
import type { WagerTransaction } from '../../domain/wager-transaction';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUID v7 (ordenável por tempo). */
  next(): string;
}

export interface WalletRepository {
  /** false se já existe wallet para (playerId, currency). */
  insert(wallet: Wallet): Promise<boolean>;
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR NO KEY UPDATE: serializa operações da MESMA wallet; wallets diferentes não se bloqueiam. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** UPDATE ... WHERE id AND version = expectedVersion. Lança ConcurrentModificationError se não casar. */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. true = inserida; false = já existia (key ou provider+externalId). */
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Persiste os campos mutáveis (status, failureCode, saldo observado, tentativas...). */
  update(tx: WagerTransaction): Promise<void>;
  /** Existe uma reversão PROCESSED apontando para esta transação? */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /** PENDING_REFERENCE vencidas, com FOR UPDATE SKIP LOCKED (várias instâncias não disputam a mesma linha). */
  claimDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. true = primeira vez; false = já recebida. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  /** payload_hash gravado para (consumer, messageId), se existir. */
  payloadHashOf(consumerName: string, messageId: string): Promise<string | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /** Pendentes e devidas, FOR UPDATE SKIP LOCKED, em ordem de seq. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage, lastError?: string): Promise<void>;
}

/** Tudo que participa da MESMA transação de banco. */
export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Executa `fn` em uma transação. Se lançar, faz rollback de TUDO (saldo, ledger, inbox, outbox). */
  run<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface LedgerPage {
  items: Array<{
    seq: number;
    id: string;
    walletId: string;
    transactionId: string;
    direction: string;
    amount: string;
    currency: string;
    balanceBefore: string;
    balanceAfter: string;
    createdAt: Date;
  }>;
  nextAfterSeq?: number | undefined;
}

export interface ReconciliationRow {
  currency: string;
  walletBalance: string;
  ledgerBalance: string;
  entries: number;
}

/** Leituras fora de transação de escrita (API de consulta). */
export interface ReadModel {
  findWallet(id: string): Promise<Wallet | undefined>;
  findTransaction(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  listLedger(walletId: string, afterSeq: number, limit: number): Promise<LedgerPage>;
  /** UMA instrução SQL => snapshot consistente de saldo e soma do ledger. */
  reconcile(walletId: string): Promise<ReconciliationRow | undefined>;
  outboxStats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }>;
  ping(): Promise<void>;
}

export interface PublishableEvent {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface EventPublisher {
  /** Pode lançar. A entrega é at-least-once: o mesmo id pode ser publicado mais de uma vez. */
  publish(event: PublishableEvent): Promise<void>;
}

export interface AppLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface Metrics {
  transactionDecided(status: string, kind: string): void;
  duplicateDetected(source: 'http' | 'sqs' | 'idempotency'): void;
  idempotencyConflict(): void;
  retry(source: 'sqs' | 'outbox' | 'reference'): void;
  dlq(reason: string): void;
  lockContention(): void;
  processingSeconds(source: 'http' | 'sqs', seconds: number): void;
  outboxLag(pending: number, oldestAgeSeconds: number): void;
  outboxPublished(): void;
  reconciliationDivergence(): void;
}

export class ConcurrentModificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentModificationError';
  }
}
