import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { TransientInfrastructureError } from '../../src/domain/errors';
import { NoFaults } from '../../src/infrastructure/messaging/fault-injector';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs';
import { WagerSqsConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { Harness, balanceOf, createHarness, keyOf, newWallet, txInput } from '../helpers/harness';
import { createTestQueues, drain, envelope, sendEnvelope, waitFor } from '../helpers/sqs';

let h: Harness;
let q: Awaited<ReturnType<typeof createTestQueues>>;
beforeAll(async () => {
  h = await createHarness();
  q = await createTestQueues();
});
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await h.reset();
  await drain(q.client, q.urls.wager, 0); await drain(q.client, q.urls.dlq, 0); await drain(q.client, q.urls.events, 0);
});

function consumer(processor: ProcessWagerTransaction = h.processWager) {
  return new WagerSqsConsumer(q.client, q.urls.wager, q.urls.dlq, processor, q.config, h.metrics, h.logger, new NoFaults());
}
const txRows = () => h.sql("SELECT status, failure_code, kind FROM wager_transactions WHERE kind <> 'OPENING'");

describe('consumer SQS', () => {
  test('mensagem válida é processada, aplicada e removida da fila (ack só após o commit)', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '10.00');
    const c = consumer(); c.start();
    try {
      await sendEnvelope(q.client, q.urls.wager, envelope(input, keyOf(input)), w.walletId);
      await waitFor(async () => (await balanceOf(h, w.walletId)) === '90.00');
      await waitFor(async () => (await drain(q.client, q.urls.wager, 0)).length === 0);
      expect(await h.sql('SELECT 1 FROM inbox_messages WHERE processed_at IS NOT NULL')).toHaveLength(1);
      expect((await drain(q.client, q.urls.dlq, 0))).toHaveLength(0);
    } finally { await c.stop(); }
  });

  test('rejeição de NEGÓCIO (saldo insuficiente) é ack e estado terminal, NÃO vai para a DLQ', async () => {
    const w = await newWallet(h, '1.00');
    const input = txInput(w, 'BET', '50.00');
    const c = consumer(); c.start();
    try {
      await sendEnvelope(q.client, q.urls.wager, envelope(input, keyOf(input)), w.walletId);
      await waitFor(async () => (await txRows()).length === 1);
      expect((await txRows())[0]).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
      expect(await drain(q.client, q.urls.dlq, 1)).toHaveLength(0);
    } finally { await c.stop(); }
  });

  test('duplicatas (mesmo messageId e mesma idempotency key) têm efeito único', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '10.00');
    const env = envelope(input, keyOf(input), 'logical-msg-1');
    const c = consumer(); c.start();
    try {
      // dedup ids diferentes => o broker entrega as duas (simula at-least-once / reenvio do provedor)
      await sendEnvelope(q.client, q.urls.wager, env, w.walletId);
      await sendEnvelope(q.client, q.urls.wager, env, w.walletId);
      await sendEnvelope(q.client, q.urls.wager, envelope(input, keyOf(input), 'logical-msg-2'), w.walletId);
      await waitFor(async () => (await h.sql('SELECT 1 FROM inbox_messages WHERE processed_at IS NOT NULL')).length === 2);
      await waitFor(async () => (await drain(q.client, q.urls.wager, 0)).length === 0);
      expect(await balanceOf(h, w.walletId)).toBe('90.00');
      expect(await txRows()).toHaveLength(1);
    } finally { await c.stop(); }
  });

  test('mensagens-veneno vão para a DLQ com o motivo, sem efeito algum', async () => {
    const w = await newWallet(h, '100.00');
    const c = consumer(); c.start();
    try {
      await q.client.send(new (await import('@aws-sdk/client-sqs')).SendMessageCommand({
        QueueUrl: q.urls.wager, MessageBody: '{not json', MessageGroupId: 'g', MessageDeduplicationId: 'bad-json',
      }));
      await sendEnvelope(q.client, q.urls.wager, { foo: 'bar' }, 'g2');
      const bad = txInput(w, 'BET', '-5.00');
      await sendEnvelope(q.client, q.urls.wager, envelope(bad, keyOf(bad)), w.walletId);
      const ok = txInput(w, 'BET', '5.00');
      await sendEnvelope(q.client, q.urls.wager, envelope(ok, keyOf(ok)), w.walletId);
      await sendEnvelope(q.client, q.urls.wager, envelope({ ...ok, money: { amount: '6.00', currency: 'BRL' } }, keyOf(ok)), w.walletId); // conflito de idempotência

      await waitFor(async () => h.metrics.get('dlq:MALFORMED_JSON') + h.metrics.get('dlq:INVALID_ENVELOPE') + h.metrics.get('dlq:INVALID_PAYLOAD') + h.metrics.get('dlq:IDEMPOTENCY_CONFLICT') === 4);
      const dlq = await drain(q.client, q.urls.dlq, 1);
      expect(dlq.map((m) => m.attrs.reason).sort()).toEqual(['IDEMPOTENCY_CONFLICT', 'INVALID_ENVELOPE', 'INVALID_PAYLOAD', 'MALFORMED_JSON']);
      expect(await balanceOf(h, w.walletId)).toBe('95.00'); // só a mensagem válida teve efeito
    } finally { await c.stop(); }
  });

  test('erro transitório: retry com backoff e sucesso na retentativa (efeito único)', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '10.00');
    let calls = 0;
    const flaky = {
      execute: (...args: Parameters<ProcessWagerTransaction['execute']>) => {
        calls += 1;
        if (calls <= 2) return Promise.reject(new TransientInfrastructureError('banco indisponível'));
        return h.processWager.execute(...args);
      },
      recordPermanentFailure: () => Promise.resolve(),
    } as unknown as ProcessWagerTransaction;
    const c = consumer(flaky); c.start();
    try {
      await sendEnvelope(q.client, q.urls.wager, envelope(input, keyOf(input)), w.walletId);
      await waitFor(async () => (await balanceOf(h, w.walletId)) === '90.00', 30_000);
      expect(calls).toBe(3);
      expect(h.metrics.get('retry:sqs')).toBe(2);
      expect(await drain(q.client, q.urls.dlq, 0)).toHaveLength(0);
    } finally { await c.stop(); }
  }, 40_000);

  test('retries esgotados: registra FAILED auditável e envia à DLQ', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '10.00');
    const dead = {
      execute: () => Promise.reject(new TransientInfrastructureError('sempre falha')),
      recordPermanentFailure: (...a: Parameters<ProcessWagerTransaction['recordPermanentFailure']>) => h.processWager.recordPermanentFailure(...a),
    } as unknown as ProcessWagerTransaction;
    const c = consumer(dead); c.start();
    try {
      await sendEnvelope(q.client, q.urls.wager, envelope(input, keyOf(input)), w.walletId);
      await waitFor(async () => h.metrics.get('dlq:MAX_RETRIES') === 1, 40_000);
      expect((await txRows())[0]).toMatchObject({ status: 'FAILED', failure_code: 'INTERNAL_ERROR' });
      expect(await balanceOf(h, w.walletId)).toBe('100.00');
      const dlq = await drain(q.client, q.urls.dlq, 1);
      expect(dlq).toHaveLength(1);
      expect(dlq[0]!.attrs.reason).toBe('MAX_RETRIES');
      expect(await h.sql("SELECT 1 FROM outbox_messages WHERE event_type = 'WagerTransactionFailed'")).toHaveLength(1);
    } finally { await c.stop(); }
  }, 60_000);

  test('wallets diferentes processam em paralelo; muitas mensagens da mesma wallet respeitam o saldo', async () => {
    const w = await newWallet(h, '20.00');
    const c = consumer(); c.start();
    try {
      const inputs = Array.from({ length: 30 }, () => txInput(w, 'BET', '1.00'));
      for (const i of inputs) await sendEnvelope(q.client, q.urls.wager, envelope(i, keyOf(i)), w.walletId);
      await waitFor(async () => (await txRows()).length === 30, 40_000);
      expect(await balanceOf(h, w.walletId)).toBe('0.00');
      const rows = await txRows();
      expect(rows.filter((r) => r.status === 'PROCESSED')).toHaveLength(20);
      expect(rows.filter((r) => r.status === 'REJECTED')).toHaveLength(10);
    } finally { await c.stop(); }
  }, 60_000);
});

describe('outbox -> SQS', () => {
  test('publica todos os eventos pendentes na fila de eventos e marca como publicados', async () => {
    const w = await newWallet(h, '100.00');
    await h.processWager.execute(txInput(w, 'BET', '10.00'), 'k1', { correlationId: 'c', source: 'http' });
    const pending = (await h.sql('SELECT id FROM outbox_messages WHERE published_at IS NULL')).map((r) => r.id as string);
    expect(pending.length).toBe(3); // opening, processed, balance changed

    const publisher = h.makeOutboxPublisher(new SqsEventPublisher(q.client, q.urls.events));
    const res = await publisher.runBatch(50);
    expect(res).toEqual({ published: 3, failed: 0 });
    expect(await h.sql('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')).toHaveLength(0);

    const msgs = await drain(q.client, q.urls.events, 1);
    const ids = msgs.map((m) => (JSON.parse(m.body) as { eventId: string }).eventId).sort();
    expect(ids).toEqual([...pending].sort());
    const processed = msgs.map((m) => JSON.parse(m.body)).find((e) => e.eventType === 'WagerTransactionProcessed');
    expect(processed.data.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(processed.version).toBe(1);
  });

  test('broker fora do ar: eventos ficam pendentes com backoff e saem quando o broker volta', async () => {
    const w = await newWallet(h, '100.00');
    let up = false;
    const sent: string[] = [];
    const flaky = { publish: async (e: { id: string }) => { if (!up) throw new Error('broker down'); sent.push(e.id); } };
    const publisher = h.makeOutboxPublisher(flaky);
    expect(await publisher.runBatch(10)).toEqual({ published: 0, failed: 1 }); // opening
    const [row] = await h.sql('SELECT attempts, next_attempt_at, last_error FROM outbox_messages');
    expect(row!.attempts).toBe(1);
    expect(row!.next_attempt_at).not.toBeNull();
    expect(row!.last_error).toContain('broker down');
    expect(await publisher.runBatch(10)).toEqual({ published: 0, failed: 0 }); // ainda dentro do backoff
    up = true;
    await h.sql("UPDATE outbox_messages SET next_attempt_at = now() - interval '1 second'");
    expect(await publisher.runBatch(10)).toEqual({ published: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    void w;
  });

  test('3 publishers concorrentes (SKIP LOCKED): nenhum evento é publicado duas vezes', async () => {
    const w = await newWallet(h, '10000.00');
    for (let i = 0; i < 40; i += 1) await h.processWager.execute(txInput(w, 'BET', '1.00'), `k${i}`, { correlationId: 'c', source: 'http' });
    const total = (await h.sql('SELECT 1 FROM outbox_messages')).length;
    const sent: string[] = [];
    const slow = { publish: async (e: { id: string }) => { await new Promise((r) => setTimeout(r, 5)); sent.push(e.id); } };
    const pubs = [h.makeOutboxPublisher(slow), h.makeOutboxPublisher(slow), h.makeOutboxPublisher(slow)];
    const loops = pubs.map(async (p) => { let n = 0; for (let i = 0; i < 20; i += 1) n += (await p.runBatch(7)).published; return n; });
    const counts = await Promise.all(loops);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
    expect(sent).toHaveLength(total);
    expect(new Set(sent).size).toBe(total); // zero duplicatas
  });

  test('crash entre publicar e commitar: o evento é republicado (at-least-once), com o MESMO eventId para o consumidor deduplicar', async () => {
    await newWallet(h, '100.00');
    const sent: string[] = [];
    const publisher = { publish: async (e: { id: string }) => { sent.push(e.id); } };
    // um "crash": a transação aborta depois de publicar
    const crashingUow = { run: (fn: any) => h.uow.run(async (ctx) => { const r = await fn(ctx); throw new TransientInfrastructureError('processo morreu antes do commit'); }) };
    const { PublishOutbox } = await import('../../src/application/use-cases/publish-outbox');
    const crashing = new PublishOutbox(crashingUow as any, publisher, h.clock, h.metrics, h.logger, { baseMs: 1, capMs: 1 });
    await expect(crashing.runBatch(10)).rejects.toThrow();
    expect(await h.sql('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')).toHaveLength(1); // continua pendente

    await h.makeOutboxPublisher(publisher).runBatch(10);
    expect(sent).toHaveLength(2); // duplicata possível...
    expect(new Set(sent).size).toBe(1); // ...mas com o mesmo eventId => consumidor idempotente descarta

    const seen = new Set<string>(); let effects = 0;
    for (const id of sent) { if (!seen.has(id)) { seen.add(id); effects += 1; } }
    expect(effects).toBe(1);
  });
});
