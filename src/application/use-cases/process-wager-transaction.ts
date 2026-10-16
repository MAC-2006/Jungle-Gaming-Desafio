import {
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidPayloadError,
  InvalidTransactionError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../domain/errors';
import { WagerTransactionFailed } from '../../domain/events/wager-events';
import { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { Money, MoneyProps } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import { Clock, IdGenerator, Metrics, UnitOfWork } from '../ports/ports';
import { hashPayload } from '../canonical';
import {
  WagerTransactionInput,
  canonicalWagerPayload,
  idempotencyKeySchema,
  parseOrThrow,
  wagerTransactionInputSchema,
} from '../schemas';
import { TransactionApplier } from '../transaction-applier';

export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessOptions {
  correlationId: string;
  source: 'http' | 'sqs';
  /** Presente apenas quando o pedido veio de uma mensagem SQS (dedup de mensagem via inbox). */
  inbox?: InboxContext;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado quando a transação foi decidida. Ausente enquanto PENDING_REFERENCE. */
  balance?: MoneyProps | undefined;
  failureCode?: FailureCode | undefined;
  /** true quando a resposta é a original, reaproveitada de uma chamada anterior com a mesma chave. */
  idempotentReplay: boolean;
  /** true quando a MENSAGEM (messageId) já tinha sido consumida (inbox). */
  duplicateMessage?: boolean;
}

export function toWagerResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultBalance?.toJSON(),
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}

export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly applier: TransactionApplier,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  async execute(rawInput: unknown, rawIdempotencyKey: unknown, options: ProcessOptions): Promise<WagerResult> {
    const { tx, payloadHash, idempotencyKey } = this.buildTransaction(rawInput, rawIdempotencyKey);

    return this.uow.run(async (ctx) => {
      // 1) Dedup de MENSAGEM (apenas SQS). Mesma transação do efeito: se algo falhar, o inbox também some.
      let inbox: InboxMessage | undefined;
      if (options.inbox) {
        inbox = InboxMessage.receive({ ...options.inbox, receivedAt: this.clock.now() });
        const firstTime = await ctx.inbox.tryReceive(inbox);
        if (!firstTime) {
          // Mesmo messageId com corpo diferente NÃO é duplicata: é reuso indevido do id da mensagem.
          const storedHash = await ctx.inbox.payloadHashOf(inbox.consumerName, inbox.messageId);
          if (storedHash !== undefined && storedHash !== inbox.payloadHash) {
            this.metrics.idempotencyConflict();
            throw new IdempotencyConflictError(`messageId "${inbox.messageId}" was already consumed with a different payload`);
          }
          this.metrics.duplicateDetected('sqs');
          const existing = await this.findExisting(ctx, tx);
          if (!existing) {
            throw new TransientInfrastructureError('inbox row exists but its transaction is not visible');
          }
          return { ...toWagerResult(existing, true), duplicateMessage: true };
        }
      }

      // 2) Idempotência de NEGÓCIO (por idempotencyKey; e por provider+externalTransactionId).
      const existing = await this.findExisting(ctx, tx);
      if (existing) {
        const replay = this.replay(existing, idempotencyKey, payloadHash);
        await this.markInboxProcessed(ctx, inbox);
        return replay;
      }

      // 3) A wallet precisa existir (leitura sem lock; wallets nunca são apagadas).
      if (!(await ctx.wallets.findById(tx.walletId))) {
        throw new WalletNotFoundError(`wallet ${tx.walletId} not found`);
      }

      // 4) Reserva a chave de idempotência no banco. Concorrentes na mesma chave bloqueiam no índice único
      //    até este commit/rollback; o perdedor cai no ramo "já existia" abaixo.
      const inserted = await ctx.transactions.insertIfAbsent(tx);
      if (!inserted) {
        this.metrics.duplicateDetected('idempotency');
        const winner = await this.findExisting(ctx, tx);
        if (!winner) throw new TransientInfrastructureError('idempotency conflict but winner is not visible');
        const replay = this.replay(winner, idempotencyKey, payloadHash);
        await this.markInboxProcessed(ctx, inbox);
        return replay;
      }

      // 5) Serializa por wallet. Ordem de locks (tx -> wallet) é a mesma em todos os caminhos: sem deadlock.
      const wallet = await ctx.wallets.lockById(tx.walletId);
      if (!wallet) throw new WalletNotFoundError(`wallet ${tx.walletId} not found`);

      await this.applier.apply(ctx, tx, wallet, options.correlationId);
      await this.markInboxProcessed(ctx, inbox);
      return toWagerResult(tx, false);
    });
  }

  /**
   * Registra FAILED (terminal, auditável) para uma mensagem que esgotou as tentativas por erro de infraestrutura.
   * Melhor esforço: se nem isso for possível (ex.: banco fora), a mensagem vai para a DLQ do mesmo jeito.
   */
  async recordPermanentFailure(rawInput: unknown, rawIdempotencyKey: unknown, correlationId: string): Promise<void> {
    const { tx } = this.buildTransaction(rawInput, rawIdempotencyKey);
    await this.uow.run(async (ctx) => {
      if (await this.findExisting(ctx, tx)) return;
      if (!(await ctx.wallets.findById(tx.walletId))) return;
      if (!(await ctx.transactions.insertIfAbsent(tx))) return;
      const now = this.clock.now();
      tx.fail(FailureCode.InternalError, now);
      await ctx.transactions.update(tx);
      await ctx.outbox.add(
        OutboxMessage.enqueue(
          WagerTransactionFailed.from(tx, {
            eventId: this.ids.next(),
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          }),
        ),
      );
      this.metrics.transactionDecided(tx.status, tx.kind);
    });
  }

  private buildTransaction(rawInput: unknown, rawKey: unknown) {
    const input: WagerTransactionInput = parseOrThrow(wagerTransactionInputSchema, rawInput, 'wager transaction');
    const idempotencyKey = parseOrThrow(idempotencyKeySchema, rawKey, 'idempotency key');
    let money: Money;
    try {
      money = Money.from(input.money);
    } catch (error) {
      if (error instanceof InvalidMoneyError) throw new InvalidPayloadError(error.message, [{ path: 'money', message: error.message }]);
      throw error;
    }
    const payloadHash = hashPayload(canonicalWagerPayload(input, money));
    try {
      const tx = WagerTransaction.create({
        id: this.ids.next(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind as WagerTransaction['kind'],
        money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: this.clock.now(),
      });
      return { tx, payloadHash, idempotencyKey };
    } catch (error) {
      if (error instanceof InvalidTransactionError) throw new InvalidPayloadError(error.message);
      throw error;
    }
  }

  private async findExisting(ctx: Parameters<Parameters<UnitOfWork['run']>[0]>[0], tx: WagerTransaction) {
    return (
      (await ctx.transactions.findByIdempotencyKey(tx.idempotencyKey)) ??
      (await ctx.transactions.findByProviderExternalId(tx.providerId, tx.externalTransactionId))
    );
  }

  /** Mesma chave + mesmo payload => resposta original. Qualquer divergência => conflito. */
  private replay(existing: WagerTransaction, key: string, payloadHash: string): WagerResult {
    if (existing.idempotencyKey !== key || !existing.matchesPayload(payloadHash)) {
      this.metrics.idempotencyConflict();
      throw new IdempotencyConflictError(
        existing.idempotencyKey !== key
          ? `externalTransactionId already used with a different idempotency key`
          : `idempotency key "${key}" was already used with a different payload`,
      );
    }
    this.metrics.duplicateDetected('idempotency');
    return toWagerResult(existing, true);
  }

  private async markInboxProcessed(
    ctx: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    inbox: InboxMessage | undefined,
  ): Promise<void> {
    if (!inbox) return;
    inbox.markProcessed(this.clock.now());
    await ctx.inbox.markProcessed(inbox);
  }
}
