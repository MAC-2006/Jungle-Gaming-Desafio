import { InvalidMoneyError, InvalidPayloadError, WalletAlreadyExistsError } from '../../domain/errors';
import { WalletBalanceChanged } from '../../domain/events/wager-events';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction } from '../../domain/wager-transaction';
import { hashPayload } from '../canonical';
import { Clock, IdGenerator, UnitOfWork } from '../ports/ports';
import { CreateWalletInput, createWalletInputSchema, parseOrThrow } from '../schemas';

export interface CreateWalletResult {
  walletId: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
  createdAt: Date;
}

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(rawInput: unknown, correlationId: string): Promise<CreateWalletResult> {
    const input: CreateWalletInput = parseOrThrow(createWalletInputSchema, rawInput, 'wallet');
    let initial: Money;
    try {
      initial = Money.from(input.initialBalance);
    } catch (error) {
      if (error instanceof InvalidMoneyError) throw new InvalidPayloadError(error.message, [{ path: 'initialBalance', message: error.message }]);
      throw error;
    }
    const now = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId: input.playerId, initialBalance: initial, now });

    return this.uow.run(async (ctx) => {
      if (!(await ctx.wallets.insert(wallet))) {
        throw new WalletAlreadyExistsError(`wallet for player ${input.playerId} in ${initial.currency} already exists`);
      }
      const opening = wallet.openingEntry({ ledgerEntryId: this.ids.next(), transactionId: this.ids.next() });
      if (opening) {
        // O crédito de abertura é um lançamento como qualquer outro: o saldo inicial nunca "aparece do nada".
        const tx = WagerTransaction.createOpening({
          id: opening.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initial,
          payloadHash: hashPayload({ walletId: wallet.id, initialBalance: initial.toJSON() }),
          now,
        });
        tx.markProcessed(undefined, now, wallet.balance);
        await ctx.transactions.insertIfAbsent(tx);
        await ctx.ledger.insert(opening);
        await ctx.outbox.add(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, opening, {
              eventId: this.ids.next(),
              correlationId,
              causationId: tx.id,
              occurredAt: now,
            }),
          ),
        );
      }
      return {
        walletId: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
        createdAt: wallet.createdAt,
      };
    });
  }
}
