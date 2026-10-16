import { describe, expect, test } from 'bun:test';
import { computeBackoffMs } from '../../src/domain/backoff';
import { InboxMessage } from '../../src/domain/inbox-message';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { Wallet } from '../../src/domain/wallet';
import { WalletBalanceChanged } from '../../src/domain/events/wager-events';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00Z');

describe('backoff', () => {
  test('exponencial e limitado pelo teto', () => {
    const p = { baseMs: 1000, capMs: 10_000 };
    expect([0, 1, 2, 3, 4, 10].map((a) => computeBackoffMs(a, p))).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });
});

describe('InboxMessage', () => {
  test('nasce não processada e marca uma vez só', () => {
    const m = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: t0 });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(t0);
    expect(m.isProcessed()).toBe(true);
    m.markProcessed(new Date(t0.getTime() + 5000));
    expect(m.processedAt).toEqual(t0);
  });
});

describe('OutboxMessage + eventos', () => {
  const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), now: t0 });
  const entry: WalletLedgerEntry = wallet.debit({ ledgerEntryId: 'e1', transactionId: 't1', money: brl('25.00'), now: t0 });
  const event = WalletBalanceChanged.from(wallet, entry, { eventId: 'ev1', correlationId: 'c1', causationId: 't1', occurredAt: t0 });

  test('envelope serializa Money como string decimal e carrega tipo e versão', () => {
    const json = event.toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(json.data.direction).toBe(LedgerDirection.Debit);
    expect(json.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
  test('data é imutável', () => {
    expect(() => {
      (event.data as { walletId: string }).walletId = 'x';
    }).toThrow();
  });
  test('enqueue usa o eventId como id e nasce pendente e devida', () => {
    const m = OutboxMessage.enqueue(event);
    expect(m.id).toBe('ev1');
    expect(m.aggregateId).toBe('w1');
    expect(m.isPending()).toBe(true);
    expect(m.isDue(t0)).toBe(true);
    expect(m.attempts).toBe(0);
  });
  test('scheduleRetry incrementa attempts e adia a próxima tentativa com backoff', () => {
    const m = OutboxMessage.enqueue(event);
    m.scheduleRetry(t0, { baseMs: 1000, capMs: 60_000 });
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt).toEqual(new Date(t0.getTime() + 1000));
    expect(m.isDue(t0)).toBe(false);
    expect(m.isDue(new Date(t0.getTime() + 1000))).toBe(true);
    m.scheduleRetry(t0, { baseMs: 1000, capMs: 60_000 });
    expect(m.nextAttemptAt).toEqual(new Date(t0.getTime() + 2000));
  });
  test('publicada deixa de ser pendente/devida', () => {
    const m = OutboxMessage.enqueue(event);
    m.markPublished(t0);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date(t0.getTime() + 999_999))).toBe(false);
  });
});
