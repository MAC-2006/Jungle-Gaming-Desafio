import { WalletNotFoundError } from '../../domain/errors';
import { Clock, IdGenerator, Metrics, UnitOfWork } from '../ports/ports';
import { TransactionApplier } from '../transaction-applier';

/**
 * Reprocessa PENDING_REFERENCE vencidas. UMA transação de banco por item: assim cada uma segura no máximo
 * um lock de wallet por vez (ordem tx -> wallet), o que elimina deadlock entre instâncias do worker.
 * FOR UPDATE SKIP LOCKED: instâncias diferentes nunca disputam a mesma linha.
 */
export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly applier: TransactionApplier,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  /** Retorna quantas transações foram reavaliadas. */
  async runBatch(limit: number): Promise<number> {
    let handled = 0;
    while (handled < limit) {
      const progressed = await this.uow.run(async (ctx) => {
        const [tx] = await ctx.transactions.claimDuePendingReference(this.clock.now(), 1);
        if (!tx) return false;
        const wallet = await ctx.wallets.lockById(tx.walletId);
        if (!wallet) throw new WalletNotFoundError(`wallet ${tx.walletId} not found`);
        await this.applier.apply(ctx, tx, wallet, `reference-retry:${tx.id}`);
        return true;
      });
      if (!progressed) break;
      handled += 1;
    }
    return handled;
  }
}
