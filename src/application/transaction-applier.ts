import { BackoffPolicy, computeBackoffMs } from '../domain/backoff';
import { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wager-events';
import { InsufficientFundsError } from '../domain/errors';
import { FailureCode } from '../domain/failure-code';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { OutboxMessage } from '../domain/outbox-message';
import { Wallet } from '../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { Clock, IdGenerator, Metrics, TransactionContext } from './ports/ports';

export interface ReferencePolicy {
  maxAttempts: number;
  backoff: BackoffPolicy;
  ttlMs: number;
}

export const DEFAULT_REFERENCE_POLICY: ReferencePolicy = {
  maxAttempts: 8,
  backoff: { baseMs: 5_000, capMs: 300_000 },
  ttlMs: 30 * 60_000,
};

/**
 * Decide e aplica UMA transação já persistida, DENTRO de uma transação de banco, com a wallet
 * já bloqueada (FOR UPDATE). Compartilhado pelo fluxo de entrada (HTTP/SQS) e pelo reprocessamento
 * de PENDING_REFERENCE, para que ambos obedeçam exatamente às mesmas regras.
 *
 * Regra de ouro: falha de NEGÓCIO vira estado terminal REJECTED (commit, auditável);
 * falha de INFRAESTRUTURA propaga como exceção (rollback + retry).
 */
export class TransactionApplier {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly referencePolicy: ReferencePolicy,
  ) {}

  async apply(ctx: TransactionContext, tx: WagerTransaction, wallet: Wallet, correlationId: string): Promise<void> {
    const now = this.clock.now();
    const eventCtx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });

    // 1) Coerência estrutural com a wallet.
    if (tx.money.currency !== wallet.currency) {
      return this.reject(ctx, tx, wallet, FailureCode.CurrencyMismatch, now, eventCtx());
    }
    if (tx.playerId !== wallet.playerId) {
      return this.reject(ctx, tx, wallet, FailureCode.PlayerMismatch, now, eventCtx());
    }

    // 2) Resolução da referência (REFUND/ROLLBACK obrigatória; WIN/LOSS se informada).
    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      reference = await ctx.transactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      if (!reference) {
        return this.waitForReference(ctx, tx, wallet, now, eventCtx());
      }
      const alreadyReversed = tx.requiresReference() ? await ctx.transactions.isReversed(reference.id) : false;
      const evaluation = tx.evaluateReference(reference, alreadyReversed);
      if (evaluation.outcome === 'pending') {
        return this.waitForReference(ctx, tx, wallet, now, eventCtx());
      }
      if (evaluation.outcome === 'reject') {
        return this.reject(ctx, tx, wallet, evaluation.code, now, eventCtx());
      }
    }

    // 3) LOSS não altera o saldo (nem gera lançamento).
    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      await ctx.transactions.update(tx);
      await this.emit(ctx, WagerTransactionProcessed.from(tx, eventCtx()));
      this.metrics.transactionDecided(tx.status, tx.kind);
      return;
    }

    // 4) Movimenta o saldo e grava o lançamento correspondente.
    const direction = tx.ledgerDirectionFor(reference);
    const expectedVersion = wallet.version;
    let entry: WalletLedgerEntry;
    try {
      const movement = { ledgerEntryId: this.ids.next(), transactionId: tx.id, money: tx.money, now };
      entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        const code =
          tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;
        return this.reject(ctx, tx, wallet, code, now, eventCtx());
      }
      throw error;
    }

    await ctx.wallets.save(wallet, expectedVersion);
    await ctx.ledger.insert(entry);
    tx.markProcessed(reference?.id, now, wallet.balance);
    await ctx.transactions.update(tx);
    await this.emit(ctx, WagerTransactionProcessed.from(tx, eventCtx()));
    await this.emit(ctx, WalletBalanceChanged.from(wallet, entry, eventCtx()));
    this.metrics.transactionDecided(tx.status, tx.kind);
  }

  private async reject(
    ctx: TransactionContext,
    tx: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    now: Date,
    eventCtx: EventContext,
  ): Promise<void> {
    tx.reject(code, now, wallet.balance);
    await ctx.transactions.update(tx);
    await this.emit(ctx, WagerTransactionRejected.from(tx, eventCtx));
    this.metrics.transactionDecided(tx.status, tx.kind);
  }

  /** Referência ainda não chegou (fora de ordem): agenda nova tentativa ou desiste no limite. */
  private async waitForReference(
    ctx: TransactionContext,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
    eventCtx: EventContext,
  ): Promise<void> {
    const isRetry = tx.status === WagerTransactionStatus.PendingReference;
    const attemptsSoFar = isRetry ? tx.referenceAttempts + 1 : 0;
    const expired = now.getTime() - tx.createdAt.getTime() > this.referencePolicy.ttlMs;

    if (isRetry && (attemptsSoFar >= this.referencePolicy.maxAttempts || expired)) {
      return this.reject(ctx, tx, wallet, FailureCode.ReferenceNotFound, now, eventCtx);
    }

    const delay = computeBackoffMs(attemptsSoFar, this.referencePolicy.backoff);
    tx.markPendingReference(new Date(now.getTime() + delay));
    await ctx.transactions.update(tx);
    if (!isRetry) {
      await this.emit(ctx, WagerTransactionPendingReference.from(tx, eventCtx));
    } else {
      this.metrics.retry('reference');
    }
    this.metrics.transactionDecided(tx.status, tx.kind);
  }

  private async emit(ctx: TransactionContext, event: IntegrationEvent<unknown>): Promise<void> {
    await ctx.outbox.add(OutboxMessage.enqueue(event));
  }
}
