export {};
/**
 * Teste de carga simples contra uma instância em execução (BASE_URL).
 *   bun run test:load            (padrões: 20 wallets, 2000 requisições, concorrência 50)
 * Mede vazão e latência e, no fim, reconcilia TODAS as wallets (invariante: saldo == ledger).
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const WALLETS = Number(process.env.WALLETS ?? 20);
const REQUESTS = Number(process.env.REQUESTS ?? 2000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);

async function http(path: string, method = 'GET', body?: unknown, key?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as any };
}

const wallets: Array<{ id: string; playerId: string }> = [];
for (let i = 0; i < WALLETS; i += 1) {
  const playerId = crypto.randomUUID();
  const r = await http('/wallets', 'POST', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
  wallets.push({ id: r.body.id, playerId });
}

const latencies: number[] = [];
const statuses = new Map<number, number>();
let issued = 0;
const started = performance.now();

async function worker() {
  while (true) {
    const n = issued++;
    if (n >= REQUESTS) return;
    const w = wallets[n % wallets.length]!;
    const kind = n % 5 === 4 ? 'WIN' : 'BET';
    const ext = `load-${n}`;
    const t0 = performance.now();
    const r = await http('/wagering/transactions', 'POST', {
      providerId: 'load', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
      roundId: `r-${n}`, gameId: 'g', kind, money: { amount: '1.50', currency: 'BRL' },
    }, `load:${ext}`);
    latencies.push(performance.now() - t0);
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - started) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!.toFixed(1);
console.log(`requests=${REQUESTS} concurrency=${CONCURRENCY} wallets=${WALLETS}`);
console.log(`throughput=${(REQUESTS / seconds).toFixed(0)} req/s  p50=${pct(0.5)}ms p95=${pct(0.95)}ms p99=${pct(0.99)}ms`);
console.log('status codes:', Object.fromEntries(statuses));

let bad = 0;
for (const w of wallets) {
  const rec = await http(`/wallets/${w.id}/reconciliation`, 'POST');
  if (!rec.body.consistent) { bad += 1; console.error('DIVERGÊNCIA', w.id, rec.body); }
}
console.log(bad === 0 ? `reconciliação: ${wallets.length}/${wallets.length} wallets consistentes` : `reconciliação: ${bad} wallets DIVERGENTES`);
process.exit(bad === 0 ? 0 : 1);
