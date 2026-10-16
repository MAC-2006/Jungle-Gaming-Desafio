import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { TransientInfrastructureError } from '../../src/domain/errors';
import { WagerTransactionStatus as S } from '../../src/domain/wager-transaction';
import { Harness, balanceOf, createHarness, ledgerOf, newWallet, submit, txInput } from '../helpers/harness';

let h: Harness;
const extra: Harness[] = [];
beforeAll(async () => {
  h = await createHarness();
  // 3 "instâncias" adicionais da aplicação: pools de conexão independentes, como processos separados
  for (let i = 0; i < 3; i += 1) extra.push(await createHarness({ noReset: true, env: { DB_POOL_MAX: '15' } }));
});
afterAll(async () => {
  await Promise.all(extra.map((e) => e.close()));
  await h.close();
});
beforeEach(async () => { await h.reset(); });

const instances = () => [h, ...extra];
const pick = (i: number) => instances()[i % instances().length]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Invariantes que valem SEMPRE, quaisquer que sejam as operações concorrentes. */
async function assertInvariants(walletId: string) {
  const entries = await ledgerOf(h, walletId);
  let running = 0;
  for (const e of entries) {
    expect(Number(e.balance_before)).toBeCloseTo(running, 2); // cadeia contínua
    running = Number(e.balance_after);
    expect(running).toBeGreaterThanOrEqual(0); // nunca negativo
  }
  expect(Number(await balanceOf(h, walletId))).toBeCloseTo(running, 2); // saldo == último lançamento
  const rec = await h.queries.reconcile(walletId);
  expect(rec.consistent).toBe(true);
}

describe('concorrência na mesma wallet', () => {
  test('50 BETs de 1.00 disputando saldo de 30.00 => exatamente 30 processadas, 20 rejeitadas, saldo 0', async () => {
    const w = await newWallet(h, '30.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => submit(pick(i), txInput(w, 'BET', '1.00'))),
    );
    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(30);
    expect(results.filter((r) => r.status === S.Rejected)).toHaveLength(20);
    expect(await balanceOf(h, w.walletId)).toBe('0.00');
    expect(await ledgerOf(h, w.walletId)).toHaveLength(31);
    await assertInvariants(w.walletId);
  });

  test('mesma idempotency key enviada 40x em paralelo por 4 instâncias => UM efeito, respostas idênticas', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => submit(pick(i), input)));
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(new Set(results.map((r) => r.balance?.amount)).size).toBe(1);
    expect(await balanceOf(h, w.walletId)).toBe('90.00');
    expect(await ledgerOf(h, w.walletId)).toHaveLength(2);
    expect(await h.sql('SELECT 1 FROM wager_transactions WHERE kind <> ?', ['OPENING'])).toHaveLength(1);
    await assertInvariants(w.walletId);
  });

  test('mix aleatório de BET/WIN/LOSS concorrentes preserva todas as invariantes', async () => {
    const w = await newWallet(h, '50.00');
    const kinds = ['BET', 'WIN', 'LOSS', 'BET', 'BET'] as const;
    await Promise.all(
      Array.from({ length: 120 }, (_, i) => {
        const kind = kinds[i % kinds.length]!;
        return submit(pick(i), txInput(w, kind, ((i % 9) + 1).toFixed(2)));
      }),
    );
    await assertInvariants(w.walletId);
  });

  test('20 REFUNDs distintos da MESMA BET concorrentes => exatamente 1 aplicado, resto ALREADY_REVERSED', async () => {
    const w = await newWallet(h, '100.00');
    const bet = txInput(w, 'BET', '40.00');
    await submit(h, bet);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        submit(pick(i), txInput(w, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId })),
      ),
    );
    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(19);
    expect(await balanceOf(h, w.walletId)).toBe('100.00'); // nunca crédito em dobro
    await assertInvariants(w.walletId);
  });

  test('REFUND e BET chegando ao mesmo tempo (fora de ordem): saldo final correto após reprocessar', async () => {
    const w = await newWallet(h, '100.00');
    const pairs = Array.from({ length: 15 }, () => {
      const bet = txInput(w, 'BET', '2.00');
      return { bet, refund: txInput(w, 'REFUND', '2.00', { referenceExternalTransactionId: bet.externalTransactionId }) };
    });
    await Promise.all(pairs.flatMap((p, i) => [submit(pick(i), p.refund), submit(pick(i + 1), p.bet)]));
    for (let round = 0; round < 6; round += 1) {
      await sleep(1_100); // backoff real de 1s dos pendentes
      await Promise.all(instances().map((i) => i.reprocessReferences.runBatch(50)));
    }
    expect(await balanceOf(h, w.walletId)).toBe('100.00'); // cada BET desfeita por exatamente um REFUND
    const pending = await h.sql("SELECT 1 FROM wager_transactions WHERE status = 'PENDING_REFERENCE'");
    expect(pending).toHaveLength(0);
    await assertInvariants(w.walletId);
  });
});

describe('lock por wallet (não global)', () => {
  test('wallet A travada não bloqueia wallet B; A só prossegue quando liberada', async () => {
    const a = await newWallet(h, '100.00');
    const b = await newWallet(h, '100.00');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedSignal = new Promise<void>((r) => { locked = r; });
    const holder = h.orm.em.fork().transactional(async (tem) => {
      await tem.execute('SELECT id FROM wallets WHERE id = ? FOR NO KEY UPDATE', [a.walletId]);
      locked();
      await gate;
    });
    await lockedSignal;

    let aDone = false;
    const aPromise = submit(extra[0]!, txInput(a, 'BET', '1.00')).then((r) => { aDone = true; return r; });
    const started = Date.now();
    const rb = await submit(extra[1]!, txInput(b, 'BET', '1.00'));
    expect(rb.status).toBe(S.Processed);
    expect(Date.now() - started).toBeLessThan(1_500); // B não esperou por A
    await sleep(300);
    expect(aDone).toBe(false); // A segue bloqueada

    release();
    await holder;
    expect((await aPromise).status).toBe(S.Processed);
    await assertInvariants(a.walletId);
    await assertInvariants(b.walletId);
  });

  test('várias wallets com carga simultânea + workers de referência rodando: sem deadlock', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => newWallet(h, '200.00')));
    const lockBefore = h.metrics.get('lock') + extra.reduce((n, e) => n + e.metrics.get('lock'), 0);
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 150; i += 1) {
      const w = wallets[i % wallets.length]!;
      const bet = txInput(w, 'BET', '1.00');
      work.push(submit(pick(i), bet));
      if (i % 3 === 0) {
        work.push(submit(pick(i + 1), txInput(w, 'REFUND', '1.00', { referenceExternalTransactionId: bet.externalTransactionId })));
      }
      if (i % 10 === 0) work.push(pick(i).reprocessReferences.runBatch(5));
    }
    const settled = await Promise.allSettled(work);
    const failures = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
    expect(failures.map((f) => String(f.reason))).toEqual([]);
    const lockAfter = h.metrics.get('lock') + extra.reduce((n, e) => n + e.metrics.get('lock'), 0);
    expect(lockAfter - lockBefore).toBe(0); // nenhum deadlock / lock timeout / serialization failure
    for (const w of wallets) await assertInvariants(w.walletId);
  });
});

describe('atomicidade', () => {
  test('falha no meio do processamento faz rollback de TUDO (saldo, ledger, tx, inbox, outbox)', async () => {
    const w = await newWallet(h, '100.00');
    const eventsBefore = (await h.sql('SELECT 1 FROM outbox_messages')).length;
    let failures = 1;
    const faultyUow = {
      run: <T>(fn: Parameters<Harness['uow']['run']>[0] extends infer F ? (ctx: any) => Promise<T> : never) =>
        h.uow.run(async (ctx) => {
          const original = ctx.outbox.add.bind(ctx.outbox);
          ctx.outbox.add = async (m: any) => {
            await original(m);
            if (failures > 0) { failures -= 1; throw new TransientInfrastructureError('boom depois de gravar saldo, ledger e 1º evento'); }
          };
          return fn(ctx);
        }),
    };
    const flaky = new ProcessWagerTransaction(faultyUow as any, h.applier, h.clock, h.ids, h.metrics);
    const input = txInput(w, 'BET', '25.00');
    const opts = { correlationId: 't', source: 'sqs' as const, inbox: { consumerName: 'wager', messageId: 'm-1', payloadHash: 'x' } };

    await expect(flaky.execute(input, 'k-1', opts)).rejects.toBeInstanceOf(TransientInfrastructureError);
    expect(await balanceOf(h, w.walletId)).toBe('100.00');
    expect(await ledgerOf(h, w.walletId)).toHaveLength(1);
    expect(await h.sql('SELECT 1 FROM wager_transactions WHERE kind <> ?', ['OPENING'])).toHaveLength(0);
    expect(await h.sql('SELECT 1 FROM inbox_messages')).toHaveLength(0);
    expect((await h.sql('SELECT 1 FROM outbox_messages')).length).toBe(eventsBefore);

    const retry = await flaky.execute(input, 'k-1', opts); // a retentativa funciona normalmente
    expect(retry.status).toBe(S.Processed);
    expect(await balanceOf(h, w.walletId)).toBe('75.00');
  });

  test('mensagem duplicada (mesmo messageId) tem efeito único; messageId novo + mesma key é replay', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '10.00');
    const opts = (messageId: string) => ({ correlationId: 't', source: 'sqs' as const, inbox: { consumerName: 'wager', messageId, payloadHash: 'h' } });
    const first = await h.processWager.execute(input, 'k-dup', opts('m-1'));
    const dup = await h.processWager.execute(input, 'k-dup', opts('m-1'));
    expect(dup.duplicateMessage).toBe(true);
    expect(dup.transactionId).toBe(first.transactionId);
    const redelivery = await h.processWager.execute(input, 'k-dup', opts('m-2'));
    expect(redelivery.idempotentReplay).toBe(true);
    expect(await balanceOf(h, w.walletId)).toBe('90.00');
    expect(await h.sql('SELECT 1 FROM inbox_messages')).toHaveLength(2);
    expect(h.metrics.get('duplicate:sqs')).toBe(1);
  });

  test('50 entregas simultâneas da MESMA mensagem em 4 instâncias => um único efeito', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '10.00');
    const opts = { correlationId: 't', source: 'sqs' as const, inbox: { consumerName: 'wager', messageId: 'same-msg', payloadHash: 'h' } };
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => pick(i).processWager.execute(input, 'k-same', opts)));
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(await balanceOf(h, w.walletId)).toBe('90.00');
    expect(await ledgerOf(h, w.walletId)).toHaveLength(2);
    await assertInvariants(w.walletId);
  });
});

describe('inbox e imutabilidade extra', () => {
  test('mesmo messageId com corpo diferente é conflito, não duplicata', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '10.00');
    const mk = (hash: string) => ({ correlationId: 't', source: 'sqs' as const, inbox: { consumerName: 'wager', messageId: 'reused-id', payloadHash: hash } });
    await h.processWager.execute(input, 'k-reuse', mk('hash-a'));
    await expect(h.processWager.execute(input, 'k-reuse', mk('hash-b'))).rejects.toThrow(/different payload/);
    expect(await balanceOf(h, w.walletId)).toBe('90.00');
  });

  test('trigger impede alterar colunas de negócio da transação (player, round, moeda, created_at)', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '10.00');
    const r = await submit(h, input);
    for (const set of ["round_id = 'x'", "game_id = 'x'", "created_at = now() - interval '1 day'", "player_id = gen_random_uuid()"]) {
      await expect(h.sql(`UPDATE wager_transactions SET ${set} WHERE id = ?`, [r.transactionId])).rejects.toThrow();
    }
  });
});

describe('reconciliação', () => {
  test('wallet íntegra é consistente', async () => {
    const w = await newWallet(h, '10.00');
    await submit(h, txInput(w, 'BET', '3.00'));
    const rec = await h.queries.reconcile(w.walletId);
    expect(rec).toMatchObject({ consistent: true, storedBalance: { amount: '7.00' }, calculatedBalance: { amount: '7.00' }, difference: { amount: '0.00' }, checkedEntries: 2 });
  });

  test('divergência é DETECTADA (log de erro + métrica), nunca corrigida em silêncio', async () => {
    const w = await newWallet(h, '10.00');
    await h.sql('ALTER TABLE wallets DISABLE TRIGGER USER');
    try {
      await h.sql('UPDATE wallets SET balance = 99.00 WHERE id = ?', [w.walletId]); // corrupção simulada
    } finally {
      await h.sql('ALTER TABLE wallets ENABLE TRIGGER USER');
    }
    const rec = await h.queries.reconcile(w.walletId);
    expect(rec.consistent).toBe(false);
    expect(rec.difference.amount).toBe('89.00');
    expect(h.metrics.get('divergence')).toBe(1);
    expect(h.logger.entries.some((e) => e.level === 'error' && e.event === 'wallet.reconciliation_divergence')).toBe(true);
    expect(await balanceOf(h, w.walletId)).toBe('99.00'); // não foi "consertado"
  });
});
