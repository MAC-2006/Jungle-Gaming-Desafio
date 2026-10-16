import { describe, expect, test } from 'bun:test';
import { InvalidTransactionError, InvalidTransactionStateError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import {
  CreateWagerTransactionProps, WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S,
} from '../../src/domain/wager-transaction';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');

let n = 0;
function props(over: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  n += 1;
  return {
    id: `t${n}`, providerId: 'prov', externalTransactionId: `ext${n}`, idempotencyKey: `prov:ext${n}`, payloadHash: 'h',
    walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1', kind: K.Bet, money: brl('10.00'), createdAt: at, ...over,
  };
}
/** Cria uma transação já PROCESSED (simula o que viria do banco). */
function processed(kind: K, over: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const tx = WagerTransaction.create(props({ kind, ...over }));
  tx.markProcessed(undefined, at, brl('0.00'));
  return tx;
}

describe('WagerTransaction: criação', () => {
  test('nasce PENDING', () => {
    expect(WagerTransaction.create(props()).status).toBe(S.Pending);
  });
  test('OPENING não pode ser submetido', () => {
    expect(() => WagerTransaction.create(props({ kind: K.Opening }))).toThrow(InvalidTransactionError);
  });
  test('provider "internal" é reservado', () => {
    expect(() => WagerTransaction.create(props({ providerId: 'internal' }))).toThrow(InvalidTransactionError);
  });
  test.each([K.Refund, K.Rollback])('%s exige referência', (kind) => {
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidTransactionError);
    const tx = WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'x' }));
    expect(tx.requiresReference()).toBe(true);
  });
  test('BET não pode carregar referência; WIN/LOSS podem mas não exigem', () => {
    expect(() => WagerTransaction.create(props({ kind: K.Bet, referenceExternalTransactionId: 'x' }))).toThrow();
    expect(WagerTransaction.create(props({ kind: K.Win })).requiresReference()).toBe(false);
    expect(WagerTransaction.create(props({ kind: K.Win, referenceExternalTransactionId: 'x' })).hasReference()).toBe(true);
  });
  test('valor zero é rejeitado', () => {
    expect(() => WagerTransaction.create(props({ money: brl('0.00') }))).toThrow(InvalidTransactionError);
  });
  test('affectsBalance é false só para LOSS', () => {
    expect(WagerTransaction.create(props({ kind: K.Bet })).affectsBalance()).toBe(true);
    expect(WagerTransaction.create(props({ kind: K.Win })).affectsBalance()).toBe(true);
    for (const kind of [K.Refund, K.Rollback]) {
      expect(WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'x' })).affectsBalance()).toBe(true);
    }
    expect(WagerTransaction.create(props({ kind: K.Loss })).affectsBalance()).toBe(false);
  });
  test('matchesPayload compara o hash', () => {
    const tx = WagerTransaction.create(props({ payloadHash: 'abc' }));
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });
});

describe('WagerTransaction: transições', () => {
  test('PENDING -> PROCESSED guarda saldo observado', () => {
    const tx = WagerTransaction.create(props());
    tx.markProcessed('ref', at, brl('90.00'));
    expect(tx.status).toBe(S.Processed);
    expect(tx.resultBalance?.amount).toBe('90.00');
    expect(tx.referenceTransactionId).toBe('ref');
    expect(tx.isTerminal()).toBe(true);
  });
  test('PENDING -> REJECTED exige failureCode', () => {
    const tx = WagerTransaction.create(props());
    tx.reject(FailureCode.InsufficientFunds, at, brl('5.00'));
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });
  test('PENDING -> PENDING_REFERENCE -> PENDING_REFERENCE (tentativas contadas) -> PROCESSED', () => {
    const tx = WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'x' }));
    tx.markPendingReference(new Date(at.getTime() + 1000));
    expect(tx.referenceAttempts).toBe(0);
    tx.markPendingReference(new Date(at.getTime() + 2000));
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('ref', at, brl('1.00'));
    expect(tx.nextAttemptAt).toBeUndefined();
  });
  test.each([
    ['markProcessed', (t: WagerTransaction) => t.markProcessed(undefined, at, brl('1.00'))],
    ['markPendingReference', (t: WagerTransaction) => t.markPendingReference(at)],
    ['reject', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, at)],
    ['fail', (t: WagerTransaction) => t.fail(FailureCode.InternalError, at)],
  ])('estado terminal não aceita %s', (_name, action) => {
    for (const terminate of [
      (t: WagerTransaction) => t.markProcessed(undefined, at, brl('1.00')),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, at),
      (t: WagerTransaction) => t.fail(FailureCode.InternalError, at),
    ]) {
      const tx = WagerTransaction.create(props());
      terminate(tx);
      expect(() => action(tx)).toThrow(InvalidTransactionStateError);
    }
  });
  test('rehydrate não revalida transições', () => {
    const tx = WagerTransaction.rehydrate({
      ...props(), status: S.Processed, referenceAttempts: 0, resultBalance: brl('1.00'), processedAt: at,
    });
    expect(tx.status).toBe(S.Processed);
    expect(tx.isTerminal()).toBe(true);
  });
});

describe('WagerTransaction: direção do lançamento', () => {
  test('BET debita; WIN, REFUND e OPENING creditam', () => {
    expect(WagerTransaction.create(props({ kind: K.Bet })).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(WagerTransaction.create(props({ kind: K.Win })).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'x' })).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });
  test('ROLLBACK é o inverso da referência', () => {
    const rb = WagerTransaction.create(props({ kind: K.Rollback, referenceExternalTransactionId: 'x' }));
    expect(rb.ledgerDirectionFor(processed(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(processed(K.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(processed(K.Refund, { referenceExternalTransactionId: 'b' }))).toBe(LedgerDirection.Debit);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
  test('LOSS não tem direção', () => {
    expect(() => WagerTransaction.create(props({ kind: K.Loss })).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction: avaliação de referência', () => {
  const refund = (over: Partial<CreateWagerTransactionProps> = {}) =>
    WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'bet', ...over }));
  const rollback = (over: Partial<CreateWagerTransactionProps> = {}) =>
    WagerTransaction.create(props({ kind: K.Rollback, referenceExternalTransactionId: 'x', ...over }));

  test('REFUND de BET processada e igual: ok', () => {
    expect(refund().evaluateReference(processed(K.Bet), false)).toEqual({ outcome: 'ok' });
  });
  test('referência não terminal: pending', () => {
    const pending = WagerTransaction.create(props());
    expect(refund().evaluateReference(pending, false)).toEqual({ outcome: 'pending' });
  });
  test('referência REJECTED/FAILED: REFERENCE_NOT_PROCESSED', () => {
    const rejected = WagerTransaction.create(props());
    rejected.reject(FailureCode.InsufficientFunds, at);
    expect(refund().evaluateReference(rejected, false)).toEqual({ outcome: 'reject', code: FailureCode.ReferenceNotProcessed });
  });
  test.each([
    ['playerId', { playerId: 'other' }],
    ['walletId', { walletId: 'other' }],
    ['roundId', { roundId: 'other' }],
    ['providerId', { providerId: 'other' }],
    ['moeda', { money: Money.from({ amount: '10.00', currency: 'USD' }) }],
  ])('%s diferente: REFERENCE_MISMATCH', (_n, over) => {
    expect(refund().evaluateReference(processed(K.Bet, over), false)).toEqual({
      outcome: 'reject', code: FailureCode.ReferenceMismatch,
    });
  });
  test('REFUND só referencia BET', () => {
    for (const kind of [K.Win, K.Loss, K.Refund, K.Rollback]) {
      const ref = processed(kind, { referenceExternalTransactionId: 'x' });
      expect(refund().evaluateReference(ref, false)).toEqual({ outcome: 'reject', code: FailureCode.ReferenceKindInvalid });
    }
  });
  test('ROLLBACK referencia BET, WIN ou REFUND, mas não LOSS nem ROLLBACK', () => {
    for (const kind of [K.Bet, K.Win]) expect(rollback().evaluateReference(processed(kind), false)).toEqual({ outcome: 'ok' });
    expect(rollback().evaluateReference(processed(K.Refund, { referenceExternalTransactionId: 'b' }), false)).toEqual({ outcome: 'ok' });
    for (const kind of [K.Loss, K.Rollback]) {
      expect(rollback().evaluateReference(processed(kind, { referenceExternalTransactionId: 'x' }), false)).toEqual({
        outcome: 'reject', code: FailureCode.ReferenceKindInvalid,
      });
    }
  });
  test('valor diferente da referência: REFERENCE_AMOUNT_MISMATCH', () => {
    expect(refund({ money: brl('9.99') }).evaluateReference(processed(K.Bet), false)).toEqual({
      outcome: 'reject', code: FailureCode.ReferenceAmountMismatch,
    });
  });
  test('já revertida: ALREADY_REVERSED', () => {
    expect(refund().evaluateReference(processed(K.Bet), true)).toEqual({ outcome: 'reject', code: FailureCode.AlreadyReversed });
  });
  test('WIN/LOSS referenciando BET: valor livre, sem checagem de reversão', () => {
    const win = WagerTransaction.create(props({ kind: K.Win, money: brl('500.00'), referenceExternalTransactionId: 'bet' }));
    expect(win.evaluateReference(processed(K.Bet), true)).toEqual({ outcome: 'ok' });
    const win2 = WagerTransaction.create(props({ kind: K.Win, referenceExternalTransactionId: 'w' }));
    expect(win2.evaluateReference(processed(K.Win), false)).toEqual({ outcome: 'reject', code: FailureCode.ReferenceKindInvalid });
  });
});
