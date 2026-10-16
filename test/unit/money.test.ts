import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('serializa sempre com 2 casas', () => {
    expect(brl('25').amount).toBe('25.00');
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('0').amount).toBe('0.00');
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('aritmética exata (0.1 + 0.2 === 0.3)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('imutável: operações devolvem nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
  });

  test('subtract/negate podem produzir negativo; from nunca aceita', () => {
    const diff = brl('1.00').subtract(brl('3.50'));
    expect(diff.isNegative()).toBe(true);
    expect(diff.amount).toBe('-2.50');
    expect(diff.negate().amount).toBe('2.50');
    expect(() => brl('-1.00')).toThrow(InvalidMoneyError);
  });

  test.each([
    'NaN', 'Infinity', '-Infinity', '1e3', '1E3', '', ' ', '1,00', '1.001', '1.', '.5', '+1.00',
    '01.00', 'abc', '0x10', '1 000', '99999999999999999999.00',
  ])('rejeita entrada inválida %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', '123'])('rejeita moeda inválida %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('conflito de moeda lança erro de domínio em todas as operações', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('comparações', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('0.00').isZero()).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
  });

  test('valores grandes mantêm precisão', () => {
    const big = brl('99999999999999999.99');
    expect(big.add(brl('0.01')).amount).toBe('100000000000000000.00');
  });
});
