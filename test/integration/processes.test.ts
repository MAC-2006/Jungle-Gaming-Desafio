import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { Harness, balanceOf, createHarness, keyOf, newWallet, txInput } from '../helpers/harness';
import { AppProcess, httpJson, queueEnv, spawnApp, uuid } from '../helpers/processes';
import { createTestQueues, drain, envelope, sendEnvelope, waitFor } from '../helpers/sqs';

let h: Harness;
let q: Awaited<ReturnType<typeof createTestQueues>>;
let apps: AppProcess[] = [];
const MARKER = '/tmp/crash-marker-' + uuid();

beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await h.reset();
  q = await createTestQueues(); // filas novas por teste: sem interferência entre cenários
  rmSync(MARKER, { force: true });
});
afterEach(async () => {
  await Promise.all(apps.map((a) => a.stop('SIGKILL')));
  apps = [];
});

const start = async (env: Record<string, string>) => {
  const app = await spawnApp({ ...queueEnv(q.prefix), ...env });
  apps.push(app);
  return app;
};

async function assertConsistent(walletId: string) {
  const rec = await h.queries.reconcile(walletId);
  expect(rec.consistent).toBe(true); // wallet.balance == saldo reconstruído pelo ledger
  const rows = await h.sql('SELECT balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq', [walletId]);
  let running = 0;
  for (const r of rows) { expect(Number(r.balance_before)).toBeCloseTo(running, 2); running = Number(r.balance_after); expect(running).toBeGreaterThanOrEqual(0); }
}

describe('processos reais', () => {
  test('3 processos simultâneos: mesma aposta 60x em paralelo => um único débito; disputa de saldo correta', async () => {
    const a = await start({ ENABLE_WORKERS: 'false' });
    const b = await start({ ENABLE_WORKERS: 'false' });
    const c = await start({ ENABLE_WORKERS: 'false' });
    const procs = [a, b, c];
    const w = await newWallet(h, '100.00');

    // (1) a mesma aposta 60 vezes, espalhada pelos 3 processos
    const same = txInput(w, 'BET', '10.00');
    const res = await Promise.all(Array.from({ length: 60 }, (_, i) =>
      httpJson(procs[i % 3]!.url('/wagering/transactions'), { method: 'POST', body: same, key: keyOf(same) })));
    expect(res.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(res.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(await balanceOf(h, w.walletId)).toBe('90.00');

    // (2) 120 apostas de 1.00 disputando 90.00 de saldo
    const results = await Promise.all(Array.from({ length: 120 }, (_, i) => {
      const input = txInput(w, 'BET', '1.00');
      return httpJson(procs[i % 3]!.url('/wagering/transactions'), { method: 'POST', body: input, key: keyOf(input) });
    }));
    expect(results.filter((r) => r.status === 201)).toHaveLength(90);
    expect(results.filter((r) => r.status === 422)).toHaveLength(30);
    expect(await balanceOf(h, w.walletId)).toBe('0.00');
    await assertConsistent(w.walletId);
  }, 90_000);

  test('worker morto DEPOIS do commit e ANTES do ack: outra instância absorve a redelivery sem duplicar efeito', async () => {
    const w = await newWallet(h, '100.00');
    const input = txInput(w, 'BET', '30.00');
    const victim = await start({ ENABLE_FAULT_INJECTION: 'true', FAULT_CRASH_AFTER_COMMIT_FILE: MARKER, ENABLE_OUTBOX_PUBLISHER: 'false', ENABLE_REFERENCE_WORKER: 'false' });
    await sendEnvelope(q.client, q.urls.wager, envelope(input, keyOf(input), 'msg-crash'), w.walletId);

    const code = await victim.exited; // o processo MORREU de verdade (exit 137) logo após o commit
    expect(code).toBe(137);
    expect(existsSync(MARKER)).toBe(true);
    expect(await balanceOf(h, w.walletId)).toBe('70.00'); // o commit aconteceu
    expect(await h.sql('SELECT 1 FROM inbox_messages WHERE processed_at IS NOT NULL')).toHaveLength(1);

    // a mensagem NÃO foi removida (sem ack); outra instância assume
    const rescuer = await start({ ENABLE_OUTBOX_PUBLISHER: 'false', ENABLE_REFERENCE_WORKER: 'false' });
    await waitFor(async () => (await drain(q.client, q.urls.wager, 1)).length === 0 ? true : false, 40_000, 500).catch(() => undefined);
    await waitFor(async () => rescuer.logs.join('').includes('"duplicateMessage":true'), 40_000);
    expect(await balanceOf(h, w.walletId)).toBe('70.00'); // continua um único débito
    expect(await h.sql("SELECT 1 FROM wager_transactions WHERE kind = 'BET'")).toHaveLength(1);
    expect(await h.sql('SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = ?', [w.walletId, 'DEBIT'])).toHaveLength(1);
    expect(await drain(q.client, q.urls.dlq, 0)).toHaveLength(0);
    await assertConsistent(w.walletId);
  }, 90_000);

  test('commit confirmado, processo morre ANTES de publicar: outra instância publica o evento (e a duplicata é segura)', async () => {
    const w = await newWallet(h, '100.00');
    // processo A só atende HTTP: confirma commit e NÃO publica (publisher desligado) — equivale a morrer antes de publicar
    const a = await start({ ENABLE_OUTBOX_PUBLISHER: 'false', ENABLE_SQS_CONSUMER: 'false', ENABLE_REFERENCE_WORKER: 'false' });
    const input = txInput(w, 'BET', '10.00');
    expect((await httpJson(a.url('/wagering/transactions'), { method: 'POST', body: input, key: keyOf(input) })).status).toBe(201);
    await a.stop('SIGKILL');
    const pending = await h.sql('SELECT id FROM outbox_messages WHERE published_at IS NULL');
    expect(pending.length).toBe(3);

    // duas instâncias publishers assumem ao mesmo tempo
    await Promise.all([
      start({ ENABLE_SQS_CONSUMER: 'false', ENABLE_REFERENCE_WORKER: 'false' }),
      start({ ENABLE_SQS_CONSUMER: 'false', ENABLE_REFERENCE_WORKER: 'false' }),
    ]);
    await waitFor(async () => (await h.sql('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')).length === 0, 30_000);
    const events = await drain(q.client, q.urls.events, 2);
    const ids = new Set(events.map((m) => (JSON.parse(m.body) as { eventId: string }).eventId));
    expect([...ids].sort()).toEqual(pending.map((p) => p.id as string).sort()); // todos publicados, nenhum perdido
  }, 90_000);

  test('REFUND entregue antes da BET (SQS) é resolvido pelo worker depois que a BET chega', async () => {
    const w = await newWallet(h, '100.00');
    const bet = txInput(w, 'BET', '40.00');
    const refund = txInput(w, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    await start({ REFERENCE_BACKOFF_BASE_MS: '1000', REFERENCE_BACKOFF_CAP_MS: '2000' });
    await sendEnvelope(q.client, q.urls.wager, envelope(refund, keyOf(refund)), w.walletId);
    await waitFor(async () => (await h.sql("SELECT 1 FROM wager_transactions WHERE status = 'PENDING_REFERENCE'")).length === 1);
    await sendEnvelope(q.client, q.urls.wager, envelope(bet, keyOf(bet)), w.walletId);
    await waitFor(async () => (await h.sql("SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING' AND status = 'PROCESSED'")).length === 2, 30_000);
    expect(await balanceOf(h, w.walletId)).toBe('100.00');
    await assertConsistent(w.walletId);
  }, 60_000);

  test('reinício do serviço (SIGTERM gracioso e SIGKILL) no meio da carga: consistência final comprovada', async () => {
    const w = await newWallet(h, '60.00');
    const inputs = Array.from({ length: 80 }, () => txInput(w, 'BET', '1.00'));
    for (const i of inputs) await sendEnvelope(q.client, q.urls.wager, envelope(i, keyOf(i)), w.walletId);

    // rodada 1: derrubado com SIGKILL (sem graça) no meio do processamento
    const first = await start({});
    await waitFor(async () => (await h.sql("SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING'")).length >= 5, 30_000);
    await first.stop('SIGKILL');

    // rodada 2: sobe de novo e é parada com SIGTERM (graceful: deve sair com código 0)
    const second = await start({});
    await waitFor(async () => (await h.sql("SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING'")).length >= 25, 30_000);
    expect(await second.stop('SIGTERM')).toBe(0);
    expect(second.logs.join('')).toContain('app.shutting_down');

    // rodada 3: termina o trabalho
    await start({});
    await waitFor(async () => (await h.sql("SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING'")).length === 80, 60_000);
    const rows = await h.sql("SELECT status FROM wager_transactions WHERE kind <> 'OPENING'");
    expect(rows.filter((r) => r.status === 'PROCESSED')).toHaveLength(60);
    expect(rows.filter((r) => r.status === 'REJECTED')).toHaveLength(20);
    expect(await balanceOf(h, w.walletId)).toBe('0.00');
    expect(await h.sql('SELECT 1 FROM wallet_ledger_entries WHERE direction = ?', ['DEBIT'])).toHaveLength(60); // nenhuma duplicata
    await assertConsistent(w.walletId);
    expect(await drain(q.client, q.urls.dlq, 0)).toHaveLength(0);
  }, 150_000);
});
