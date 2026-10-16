import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  now: Date;
}

/** Aggregate Root. Saldo e ledger só mudam juntos: cada debit/credit devolve o lançamento correspondente. */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance must not be negative');
    }
    // version inicia em 1; o crédito OPENING faz parte da criação e não incrementa a versão.
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lançamento OPENING de uma wallet recém-aberta com saldo > 0. */
  openingEntry(props: { ledgerEntryId: string; transactionId: string }): WalletLedgerEntry | undefined {
    if (this._version !== 1) {
      throw new InvalidWalletError('opening entry only exists for a freshly opened wallet');
    }
    if (!this._balance.isPositive()) return undefined;
    return WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this.createdAt,
    });
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) {
      throw new InvalidWalletError('movement amount must be positive');
    }
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(`balance ${this._balance} is less than ${props.money}`);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) {
      throw new InvalidWalletError('movement amount must be positive');
    }
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  private apply(direction: LedgerDirection, newBalance: Money, props: MovementProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: props.now,
    });
    this._balance = newBalance;
    this._version += 1; // incrementa somente quando o saldo muda
    this._updatedAt = props.now;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet currency is ${this.currency}, operation is ${money.currency}`);
    }
  }
}
