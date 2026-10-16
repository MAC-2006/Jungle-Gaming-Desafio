import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const base = {
  id: 'e1', walletId: 'w1', transactionId: 't1', createdAt: new Date(),
  direction: LedgerDirection.Debit, money: brl('10.00'), balanceBefore: brl('100.00'), balanceAfter: brl('90.00'),
};

describe('WalletLedgerEntry', () => {
  test('cria lançamento balanceado', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });
  test('create valida a aritmética', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('91.00') })).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit }),
    ).toThrow(InvalidLedgerEntryError);
  });
  test('rejeita valor zero e saldos negativos', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('100.00') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl('5.00'), balanceAfter: brl('5.00').subtract(brl('10.00')) }),
    ).toThrow(InvalidLedgerEntryError);
  });
  test('rehydrate não revalida (reconstrói o que já foi persistido)', () => {
    const e = WalletLedgerEntry.rehydrate({ ...base, balanceAfter: brl('1.00') });
    expect(e.isBalanced()).toBe(false);
  });
  test('não expõe métodos de transição (imutabilidade estrutural)', () => {
    const e = WalletLedgerEntry.create(base);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(e));
    expect(proto.sort()).toEqual(['constructor', 'isBalanced']);
  });
});
