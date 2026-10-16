import { InvalidPayloadError, TransactionNotFoundError, WalletNotFoundError } from '../../domain/errors';
import { Money } from '../../domain/money';
import { AppLogger, Metrics, ReadModel } from '../ports/ports';

export class WalletQueries {
  constructor(
    private readonly reads: ReadModel,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async getWallet(id: string) {
    const wallet = await this.reads.findWallet(id);
    if (!wallet) throw new WalletNotFoundError(`wallet ${id} not found`);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  /** Ledger paginado por cursor opaco (seq), em ordem cronológica: estável mesmo com novos lançamentos. */
  async getLedger(walletId: string, cursor: string | undefined, limit: number) {
    if (!(await this.reads.findWallet(walletId))) throw new WalletNotFoundError(`wallet ${walletId} not found`);
    const afterSeq = decodeCursor(cursor);
    const page = await this.reads.listLedger(walletId, afterSeq, limit);
    return {
      items: page.items.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        amount: { amount: e.amount, currency: e.currency },
        balanceBefore: { amount: e.balanceBefore, currency: e.currency },
        balanceAfter: { amount: e.balanceAfter, currency: e.currency },
        createdAt: e.createdAt,
      })),
      nextCursor: page.nextAfterSeq !== undefined ? encodeCursor(page.nextAfterSeq) : null,
    };
  }

  async getTransaction(id: string) {
    const tx = await this.reads.findTransaction(id);
    if (!tx) throw new TransactionNotFoundError(`transaction ${id} not found`);
    return presentTransaction(tx);
  }

  async getTransactionByExternal(providerId: string, externalTransactionId: string) {
    const tx = await this.reads.findTransactionByExternal(providerId, externalTransactionId);
    if (!tx) throw new TransactionNotFoundError(`transaction ${providerId}/${externalTransactionId} not found`);
    return presentTransaction(tx);
  }

  /**
   * Recalcula o saldo a partir do ledger e compara com o saldo materializado.
   * Divergência NÃO é corrigida em silêncio: vira log de erro + métrica.
   */
  async reconcile(walletId: string) {
    const row = await this.reads.reconcile(walletId);
    if (!row) throw new WalletNotFoundError(`wallet ${walletId} not found`);
    const stored = Money.fromStored(row.walletBalance, row.currency);
    const computed = Money.fromStored(row.ledgerBalance, row.currency);
    const consistent = stored.equals(computed);
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('wallet.reconciliation_divergence', {
        walletId,
        walletBalance: row.walletBalance,
        ledgerBalance: row.ledgerBalance,
      });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: computed.toJSON(),
      difference: stored.subtract(computed).toJSON(),
      consistent,
      checkedEntries: row.entries,
    };
  }
}

function presentTransaction(tx: import('../../domain/wager-transaction').WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balance: tx.resultBalance?.toJSON() ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextAttemptAt: tx.nextAttemptAt ?? null,
    createdAt: tx.createdAt,
    processedAt: tx.processedAt ?? null,
  };
}

export function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ s: seq }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof parsed.s === 'number' && Number.isInteger(parsed.s) && parsed.s >= 0) return parsed.s;
  } catch {
    /* cai no erro abaixo */
  }
  throw new InvalidPayloadError('invalid cursor');
}

