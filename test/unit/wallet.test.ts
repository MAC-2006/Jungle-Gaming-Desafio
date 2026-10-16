import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from '../../src/domain/errors';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00Z');
const open = (balance = '100.00') => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(balance), now });
const mv = (amount: string, n = 1) => ({ ledgerEntryId: `e${n}`, transactionId: `t${n}`, money: brl(amount), now });

describe('Wallet', () => {
  test('abre com version 1 e a moeda do saldo inicial', () => {
    const w = open();
    expect(w.version).toBe(1);
    expect(w.currency).toBe('BRL');
    expect(w.balance.amount).toBe('100.00');
  });

  test('openingEntry: crédito de abertura só existe com saldo > 0', () => {
    const entry = open('100.00').openingEntry({ ledgerEntryId: 'e0', transactionId: 't0' });
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.amount).toBe('0.00');
    expect(entry?.balanceAfter.amount).toBe('100.00');
    expect(open('0').openingEntry({ ledgerEntryId: 'e0', transactionId: 't0' })).toBeUndefined();
  });

  test('debit gera lançamento coerente e incrementa version', () => {
    const w = open();
    const entry = w.debit(mv('30.00'));
    expect(w.balance.amount).toBe('70.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit gera lançamento coerente', () => {
    const w = open();
    const entry = w.credit(mv('5.50'));
    expect(w.balance.amount).toBe('105.50');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('saldo nunca fica negativo e o estado não muda na falha', () => {
    const w = open('100.00');
    expect(() => w.debit(mv('100.01'))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('100.00');
    expect(w.version).toBe(1);
  });

  test('debitar exatamente o saldo é permitido', () => {
    const w = open('80.00');
    w.debit(mv('80.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('moeda diferente é rejeitada', () => {
    const w = open();
    expect(() => w.debit({ ...mv('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) })).toThrow(
      CurrencyMismatchError,
    );
  });

  test('valor zero em movimentação é rejeitado', () => {
    expect(() => open().credit(mv('0.00'))).toThrow(InvalidWalletError);
  });

  test('sequência de operações preserva a cadeia do ledger', () => {
    const w = open('100.00');
    const e1 = w.debit(mv('40.00', 1));
    const e2 = w.credit(mv('10.00', 2));
    const e3 = w.debit(mv('70.00', 3));
    expect(e2.balanceBefore.equals(e1.balanceAfter)).toBe(true);
    expect(e3.balanceBefore.equals(e2.balanceAfter)).toBe(true);
    expect(w.balance.isZero()).toBe(true);
    expect(w.version).toBe(4);
  });
});
