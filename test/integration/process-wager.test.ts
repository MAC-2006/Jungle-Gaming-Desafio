import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError, InvalidPayloadError, WalletNotFoundError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { WagerTransactionStatus as S } from '../../src/domain/wager-transaction';
import { Harness, balanceOf, createHarness, eventTypes, keyOf, ledgerOf, newWallet, submit, txInput } from '../helpers/harness';

let h: Harness;
beforeAll(async () => { h = await createHarness({ fakeClock: true }); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await h.reset(); });

describe('criação de wallet', () => {
  test('saldo inicial vira lançamento OPENING e evento', async () => {
    const w = await newWallet(h, '100.00');
    const ledger = await ledgerOf(h, w.walletId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.direction).toBe('CREDIT');
    expect(String(ledger[0]!.balance_after)).toBe('100.00');
    expect(await eventTypes(h)).toEqual(['WalletBalanceChanged']);
  });
  test('saldo zero não gera lançamento', async () => {
    const w = await newWallet(h, '0.00');
    expect(await ledgerOf(h, w.walletId)).toHaveLength(0);
  });
  test('duplicada (player + moeda) é rejeitada; outra moeda é permitida', async () => {
    const w = await newWallet(h, '10.00');
    await expect(h.createWallet.execute({ playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }, 'c')).rejects.toThrow(/already exists/);
    await h.createWallet.execute({ playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'USD' } }, 'c');
  });
  test('saldo inicial inválido é rejeitado', async () => {
    for (const amount of ['-1.00', '1.001', 'abc', '1e3']) {
      await expect(h.createWallet.execute({ playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } }, 'c')).rejects.toBeInstanceOf(InvalidPayloadError);
    }
  });
});

describe('BET / WIN / LOSS', () => {
  test('BET debita, gera lançamento coerente e eventos', async () => {
    const w = await newWallet(h, '100.00');
    const r = await submit(h, txInput(w, 'BET', '25.00'));
    expect(r.status).toBe(S.Processed);
    expect(r.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(r.idempotentReplay).toBe(false);
    expect(await balanceOf(h, w.walletId)).toBe('75.00');
    const ledger = await ledgerOf(h, w.walletId);
    expect(ledger).toHaveLength(2);
    expect(ledger[1]!.direction).toBe('DEBIT');
    expect(String(ledger[1]!.balance_before)).toBe('100.00');
    expect(String(ledger[1]!.balance_after)).toBe('75.00');
    expect(await eventTypes(h)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('WIN credita; LOSS processa sem lançamento e sem alterar saldo', async () => {
    const w = await newWallet(h, '100.00');
    const bet = txInput(w, 'BET', '10.00');
    await submit(h, bet);
    const win = await submit(h, txInput(w, 'WIN', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(win.balance?.amount).toBe('120.00');
    const loss = await submit(h, txInput(w, 'LOSS', '5.00'));
    expect(loss.status).toBe(S.Processed);
    expect(loss.balance?.amount).toBe('120.00');
    expect(await ledgerOf(h, w.walletId)).toHaveLength(3); // opening, bet, win (LOSS não lança)
    expect(await balanceOf(h, w.walletId)).toBe('120.00');
  });

  test('saldo insuficiente: REJECTED persistido, saldo e ledger intactos', async () => {
    const w = await newWallet(h, '10.00');
    const r = await submit(h, txInput(w, 'BET', '10.01'));
    expect(r.status).toBe(S.Rejected);
    expect(r.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(r.balance?.amount).toBe('10.00');
    expect(await balanceOf(h, w.walletId)).toBe('10.00');
    expect(await ledgerOf(h, w.walletId)).toHaveLength(1);
    const [row] = await h.sql('SELECT status, failure_code FROM wager_transactions WHERE id = ?', [r.transactionId]);
    expect(row).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await eventTypes(h)).toContain('WagerTransactionRejected');
  });

  test('apostar exatamente o saldo zera a wallet', async () => {
    const w = await newWallet(h, '10.00');
    expect((await submit(h, txInput(w, 'BET', '10.00'))).status).toBe(S.Processed);
    expect(await balanceOf(h, w.walletId)).toBe('0.00');
  });

  test('moeda diferente da wallet e player diferente: REJECTED de negócio', async () => {
    const w = await newWallet(h, '50.00');
    const usd = await submit(h, txInput(w, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }));
    expect(usd.failureCode).toBe(FailureCode.CurrencyMismatch);
    const other = await submit(h, txInput(w, 'BET', '1.00', { playerId: crypto.randomUUID() }));
    expect(other.failureCode).toBe(FailureCode.PlayerMismatch);
    expect(await balanceOf(h, w.walletId)).toBe('50.00');
  });

  test('wallet inexistente é erro (404), sem efeito colateral', async () => {
    const w = await newWallet(h);
    await expect(submit(h, txInput({ ...w, walletId: crypto.randomUUID() }, 'BET', '1.00'))).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(await h.sql('SELECT 1 FROM wager_transactions WHERE kind <> ?', ['OPENING'])).toHaveLength(0);
  });

  test.each([
    ['valor negativo', { money: { amount: '-1.00', currency: 'BRL' } }],
    ['mais de 2 casas', { money: { amount: '1.005', currency: 'BRL' } }],
    ['valor zero', { money: { amount: '0.00', currency: 'BRL' } }],
    ['notação científica', { money: { amount: '1e2', currency: 'BRL' } }],
    ['moeda inválida', { money: { amount: '1.00', currency: 'brl' } }],
    ['playerId não-uuid', { playerId: 'abc' }],
    ['campo desconhecido', { extra: 1 } as never],
    ['OPENING externo', { kind: 'OPENING' } as never],
    ['provider reservado', { providerId: 'internal' }],
    ['BET com referência', { referenceExternalTransactionId: 'x' }],
  ])('payload inválido (%s) => InvalidPayloadError e nada é gravado', async (_n, over) => {
    const w = await newWallet(h);
    await expect(submit(h, txInput(w, 'BET', '1.00', over as never))).rejects.toBeInstanceOf(InvalidPayloadError);
    expect(await h.sql('SELECT 1 FROM wager_transactions WHERE kind <> ?', ['OPENING'])).toHaveLength(0);
  });

  test('REFUND/ROLLBACK sem referência => payload inválido', async () => {
    const w = await newWallet(h);
    await expect(submit(h, txInput(w, 'REFUND', '1.00'))).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(submit(h, txInput(w, 'ROLLBACK', '1.00'))).rejects.toBeInstanceOf(InvalidPayloadError);
  });
});

describe('idempotência', () => {
  test('mesma chave + mesmo payload: resposta original, sem novo lançamento', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '25.00');
    const first = await submit(h, input);
    const second = await submit(h, input);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance).toEqual(first.balance);
    expect(await balanceOf(h, w.walletId)).toBe('75.00');
    expect(await ledgerOf(h, w.walletId)).toHaveLength(2);
    expect(h.metrics.get('duplicate:idempotency')).toBeGreaterThan(0);
  });

  test('replay devolve o saldo ORIGINAL, mesmo que a wallet tenha mudado depois', async () => {
    const w = await newWallet(h, '100.00');
    const first = txInput(w, 'BET', '10.00');
    await submit(h, first);
    await submit(h, txInput(w, 'BET', '40.00'));
    const replay = await submit(h, first);
    expect(replay.balance?.amount).toBe('90.00');
  });

  test('replay de REJECTED devolve a mesma rejeição', async () => {
    const w = await newWallet(h, '1.00');
    const input = txInput(w, 'BET', '50.00');
    const first = await submit(h, input);
    await h.sql('SELECT 1'); // nada muda
    const second = await submit(h, input);
    expect(second.status).toBe(S.Rejected);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(second.transactionId).toBe(first.transactionId);
  });

  test('"25" e "25.00" são o mesmo payload', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '25.00');
    await submit(h, input);
    const replay = await submit(h, { ...input, money: { amount: '25', currency: 'BRL' } });
    expect(replay.idempotentReplay).toBe(true);
  });

  test('mesma chave com payload diferente => IdempotencyConflictError', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '25.00');
    await submit(h, input);
    await expect(submit(h, { ...input, money: { amount: '26.00', currency: 'BRL' } })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(submit(h, { ...input, roundId: 'outra' })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(h, w.walletId)).toBe('75.00');
    expect(h.metrics.get('conflict')).toBe(2);
  });

  test('mesmo externalTransactionId com chave diferente => conflito', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '25.00');
    await submit(h, input, 'key-1');
    await expect(submit(h, input, 'key-2')).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(h, w.walletId)).toBe('75.00');
  });

  test('mesma chave em wallets diferentes (payload diferente) é conflito, não vaza efeito', async () => {
    const a = await newWallet(h, '100.00');
    const b = await newWallet(h, '100.00');
    const input = txInput(a, 'BET', '10.00');
    await submit(h, input);
    await expect(submit(h, { ...input, walletId: b.walletId, playerId: b.playerId }, keyOf(input))).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(h, b.walletId)).toBe('100.00');
  });
});

describe('referências e reversões', () => {
  async function betted(balance = '100.00', amount = '20.00') {
    const w = await newWallet(h, balance);
    const bet = txInput(w, 'BET', amount);
    await submit(h, bet);
    return { w, bet };
  }

  test('REFUND devolve o valor da BET', async () => {
    const { w, bet } = await betted();
    const r = await submit(h, txInput(w, 'REFUND', '20.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(r.status).toBe(S.Processed);
    expect(r.balance?.amount).toBe('100.00');
    const ledger = await ledgerOf(h, w.walletId);
    expect(ledger.map((l) => l.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
  });

  test('ROLLBACK é o inverso da referência (BET -> crédito; WIN -> débito; REFUND -> débito)', async () => {
    const { w, bet } = await betted('100.00', '20.00');
    const rbBet = await submit(h, txInput(w, 'ROLLBACK', '20.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rbBet.balance?.amount).toBe('100.00');

    const bet2 = txInput(w, 'BET', '10.00');
    await submit(h, bet2);
    const win = txInput(w, 'WIN', '50.00', { referenceExternalTransactionId: bet2.externalTransactionId });
    await submit(h, win);
    expect(await balanceOf(h, w.walletId)).toBe('140.00');
    const rbWin = await submit(h, txInput(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rbWin.balance?.amount).toBe('90.00');

    const bet3 = txInput(w, 'BET', '10.00');
    await submit(h, bet3);
    const refund = txInput(w, 'REFUND', '10.00', { referenceExternalTransactionId: bet3.externalTransactionId });
    await submit(h, refund);
    expect(await balanceOf(h, w.walletId)).toBe('90.00');
    const rbRefund = await submit(h, txInput(w, 'ROLLBACK', '10.00', { referenceExternalTransactionId: refund.externalTransactionId }));
    expect(rbRefund.balance?.amount).toBe('80.00');
  });

  test('referência não pode ser revertida duas vezes (nem por tipos diferentes)', async () => {
    const { w, bet } = await betted();
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    expect((await submit(h, txInput(w, 'REFUND', '20.00', ref))).status).toBe(S.Processed);
    const again = await submit(h, txInput(w, 'REFUND', '20.00', ref));
    expect(again.failureCode).toBe(FailureCode.AlreadyReversed);
    const rb = await submit(h, txInput(w, 'ROLLBACK', '20.00', ref));
    expect(rb.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(await balanceOf(h, w.walletId)).toBe('100.00');
  });

  test('reversão com valor diferente da referência é rejeitada', async () => {
    const { w, bet } = await betted();
    const r = await submit(h, txInput(w, 'REFUND', '19.99', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(r.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });

  test('reversão cruzada (outro player/wallet/rodada) é rejeitada', async () => {
    const { w, bet } = await betted();
    const other = await newWallet(h, '100.00');
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    expect((await submit(h, txInput(other, 'REFUND', '20.00', ref))).failureCode).toBe(FailureCode.ReferenceMismatch);
    expect((await submit(h, txInput(w, 'REFUND', '20.00', { ...ref, roundId: 'round-X' }))).failureCode).toBe(FailureCode.ReferenceMismatch);
    expect((await submit(h, txInput(w, 'REFUND', '20.00', { ...ref, providerId: 'provider-b' }))).status).toBe(S.PendingReference); // provider diferente: referência não existe nele
    expect(await balanceOf(h, other.walletId)).toBe('100.00');
  });

  test('tipo de referência inválido: REFUND de WIN; ROLLBACK de LOSS', async () => {
    const { w, bet } = await betted();
    const win = txInput(w, 'WIN', '5.00', { referenceExternalTransactionId: bet.externalTransactionId });
    await submit(h, win);
    expect((await submit(h, txInput(w, 'REFUND', '5.00', { referenceExternalTransactionId: win.externalTransactionId }))).failureCode).toBe(FailureCode.ReferenceKindInvalid);
    const loss = txInput(w, 'LOSS', '1.00');
    await submit(h, loss);
    expect((await submit(h, txInput(w, 'ROLLBACK', '1.00', { referenceExternalTransactionId: loss.externalTransactionId }))).failureCode).toBe(FailureCode.ReferenceKindInvalid);
  });

  test('referência que foi REJECTED não pode ser revertida', async () => {
    const w = await newWallet(h, '1.00');
    const bet = txInput(w, 'BET', '50.00');
    expect((await submit(h, bet)).status).toBe(S.Rejected);
    const r = await submit(h, txInput(w, 'REFUND', '50.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(r.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(await balanceOf(h, w.walletId)).toBe('1.00');
  });

  test('reversão que deixaria o saldo negativo => REVERSAL_INSUFFICIENT_FUNDS (distinto de INSUFFICIENT_FUNDS)', async () => {
    const w = await newWallet(h, '10.00');
    const bet = txInput(w, 'BET', '10.00');
    await submit(h, bet);
    const win = txInput(w, 'WIN', '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    await submit(h, win); // saldo 40
    await submit(h, txInput(w, 'BET', '40.00')); // saldo 0
    const rb = await submit(h, txInput(w, 'ROLLBACK', '40.00', { referenceExternalTransactionId: win.externalTransactionId }));
    expect(rb.status).toBe(S.Rejected);
    expect(rb.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(await balanceOf(h, w.walletId)).toBe('0.00');
  });

  test('WIN referenciando BET de outra rodada é rejeitado', async () => {
    const { w, bet } = await betted();
    const r = await submit(h, txInput(w, 'WIN', '5.00', { roundId: 'round-2', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(r.failureCode).toBe(FailureCode.ReferenceMismatch);
  });
});

describe('referência fora de ordem (PENDING_REFERENCE)', () => {
  test('REFUND antes da BET fica pendente e é aplicado quando a BET chega', async () => {
    const w = await newWallet(h, '100.00');
    const bet = txInput(w, 'BET', '30.00');
    const refund = txInput(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });

    const pending = await submit(h, refund);
    expect(pending.status).toBe(S.PendingReference);
    expect(await balanceOf(h, w.walletId)).toBe('100.00');
    expect(await eventTypes(h)).toContain('WagerTransactionPendingReference');

    // nada devido ainda
    expect(await h.reprocessReferences.runBatch(10)).toBe(0);

    await submit(h, bet); // saldo 70
    h.fakeClock!.advance(2_000);
    expect(await h.reprocessReferences.runBatch(10)).toBe(1);

    const [row] = await h.sql('SELECT status, balance_after FROM (SELECT status, result_balance AS balance_after FROM wager_transactions WHERE id = ?) t', [pending.transactionId]);
    expect(row).toMatchObject({ status: 'PROCESSED' });
    expect(await balanceOf(h, w.walletId)).toBe('100.00');
    const replay = await submit(h, refund);
    expect(replay.status).toBe(S.Processed);
    expect(replay.idempotentReplay).toBe(true);
  });

  test('reenvio da transação pendente devolve PENDING_REFERENCE sem duplicar', async () => {
    const w = await newWallet(h, '100.00');
    const refund = txInput(w, 'REFUND', '30.00', { referenceExternalTransactionId: 'nunca-vista' });
    const a = await submit(h, refund);
    const b = await submit(h, refund);
    expect(b.status).toBe(S.PendingReference);
    expect(b.idempotentReplay).toBe(true);
    expect(b.transactionId).toBe(a.transactionId);
    expect((await eventTypes(h)).filter((t) => t === 'WagerTransactionPendingReference')).toHaveLength(1);
  });

  test('referência que nunca chega: após o limite de tentativas vira REJECTED/REFERENCE_NOT_FOUND', async () => {
    const w = await newWallet(h, '100.00');
    const refund = txInput(w, 'REFUND', '30.00', { referenceExternalTransactionId: 'nunca-chega' });
    const first = await submit(h, refund);
    expect(first.status).toBe(S.PendingReference);
    for (let i = 0; i < 10; i += 1) {
      h.fakeClock!.advance(10_000);
      await h.reprocessReferences.runBatch(10);
    }
    const [row] = await h.sql('SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE id = ?', [first.transactionId]);
    expect(row).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect(await balanceOf(h, w.walletId)).toBe('100.00');
    expect(await eventTypes(h)).toContain('WagerTransactionRejected');
  });

  test('o backoff é respeitado: nada acontece antes de nextAttemptAt', async () => {
    const w = await newWallet(h, '100.00');
    const refund = txInput(w, 'REFUND', '30.00', { referenceExternalTransactionId: 'x' });
    await submit(h, refund);
    h.fakeClock!.advance(500);
    expect(await h.reprocessReferences.runBatch(10)).toBe(0);
    h.fakeClock!.advance(600);
    expect(await h.reprocessReferences.runBatch(10)).toBe(1);
  });

  test('WIN com referência ainda inexistente também aguarda a BET', async () => {
    const w = await newWallet(h, '100.00');
    const bet = txInput(w, 'BET', '10.00');
    const win = txInput(w, 'WIN', '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submit(h, win)).status).toBe(S.PendingReference);
    await submit(h, bet);
    h.fakeClock!.advance(2000);
    await h.reprocessReferences.runBatch(10);
    expect(await balanceOf(h, w.walletId)).toBe('115.00');
  });
});
