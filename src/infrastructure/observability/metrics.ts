import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Metrics } from '../../application/ports/ports';

export class PromMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly decided: Counter<'status' | 'kind'>;
  private readonly duplicates: Counter<'source'>;
  private readonly conflicts: Counter<string>;
  private readonly retries: Counter<'source'>;
  private readonly dlqs: Counter<'reason'>;
  private readonly locks: Counter<string>;
  private readonly latency: Histogram<'source'>;
  private readonly outboxPending: Gauge<string>;
  private readonly outboxOldest: Gauge<string>;
  private readonly outboxSent: Counter<string>;
  private readonly divergences: Counter<string>;

  constructor() {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });
    this.decided = new Counter({ name: 'wager_transactions_total', help: 'Transações decididas', labelNames: ['status', 'kind'], registers });
    this.duplicates = new Counter({ name: 'wager_duplicates_total', help: 'Duplicidades detectadas', labelNames: ['source'], registers });
    this.conflicts = new Counter({ name: 'wager_idempotency_conflicts_total', help: 'Conflitos de idempotência (mesma chave, payload diferente)', registers });
    this.retries = new Counter({ name: 'wager_retries_total', help: 'Retentativas', labelNames: ['source'], registers });
    this.dlqs = new Counter({ name: 'wager_dlq_total', help: 'Mensagens enviadas à DLQ', labelNames: ['reason'], registers });
    this.locks = new Counter({ name: 'wager_lock_contention_total', help: 'Contenção de lock / deadlock / timeout', registers });
    this.latency = new Histogram({
      name: 'wager_processing_seconds', help: 'Latência de processamento', labelNames: ['source'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers,
    });
    this.outboxPending = new Gauge({ name: 'wager_outbox_pending', help: 'Eventos pendentes na outbox', registers });
    this.outboxOldest = new Gauge({ name: 'wager_outbox_oldest_age_seconds', help: 'Idade do evento pendente mais antigo (lag)', registers });
    this.outboxSent = new Counter({ name: 'wager_outbox_published_total', help: 'Eventos publicados', registers });
    this.divergences = new Counter({ name: 'wager_reconciliation_divergence_total', help: 'Divergências saldo x ledger', registers });
  }

  transactionDecided(status: string, kind: string): void { this.decided.inc({ status, kind }); }
  duplicateDetected(source: 'http' | 'sqs' | 'idempotency'): void { this.duplicates.inc({ source }); }
  idempotencyConflict(): void { this.conflicts.inc(); }
  retry(source: 'sqs' | 'outbox' | 'reference'): void { this.retries.inc({ source }); }
  dlq(reason: string): void { this.dlqs.inc({ reason }); }
  lockContention(): void { this.locks.inc(); }
  processingSeconds(source: 'http' | 'sqs', seconds: number): void { this.latency.observe({ source }, seconds); }
  outboxLag(pending: number, oldestAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxOldest.set(oldestAgeSeconds);
  }
  outboxPublished(): void { this.outboxSent.inc(); }
  reconciliationDivergence(): void { this.divergences.inc(); }
}

/** Para testes: conta chamadas sem depender do prom-client. */
export class CountingMetrics implements Metrics {
  readonly counts = new Map<string, number>();
  private bump(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
  transactionDecided(status: string, kind: string): void { this.bump(`decided:${status}:${kind}`); this.bump(`decided:${status}`); }
  duplicateDetected(source: string): void { this.bump(`duplicate:${source}`); }
  idempotencyConflict(): void { this.bump('conflict'); }
  retry(source: string): void { this.bump(`retry:${source}`); }
  dlq(reason: string): void { this.bump(`dlq:${reason}`); }
  lockContention(): void { this.bump('lock'); }
  processingSeconds(): void { /* ignorado */ }
  outboxLag(): void { /* ignorado */ }
  outboxPublished(): void { this.bump('outbox_published'); }
  reconciliationDivergence(): void { this.bump('divergence'); }
}
