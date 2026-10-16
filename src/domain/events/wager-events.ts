import { FailureCode } from '../failure-code';
import { LedgerDirection, WalletLedgerEntry } from '../ledger-entry';
import type { MoneyProps } from '../money';
import { Wallet } from '../wallet';
import { WagerTransaction } from '../wager-transaction';
import { EventContext, IntegrationEvent } from './integration-event';

interface TransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
}

function base(tx: WagerTransaction): TransactionEventBase {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

// ------------------------------------------------------------------ Processed
export interface WagerTransactionProcessedData extends TransactionEventBase {
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...base(tx), balance: tx.resultBalance!.toJSON() },
    });
  }
}

// ------------------------------------------------------------------ Rejected
export interface WagerTransactionRejectedData extends TransactionEventBase {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...base(tx), failureCode: tx.failureCode! },
    });
  }
}

// ------------------------------------------------------------------ PendingReference
export interface WagerTransactionPendingReferenceData extends TransactionEventBase {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...base(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId! },
    });
  }
}

// ------------------------------------------------------------------ WalletBalanceChanged
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

// ------------------------------------------------------------------ Failed
export interface WagerTransactionFailedData extends TransactionEventBase {
  failureCode: FailureCode;
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...base(tx), failureCode: tx.failureCode! },
    });
  }
}
