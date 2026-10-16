import type { AppLogger, Clock, Metrics, ReadModel } from '../../application/ports/ports';
import type { PublishOutbox } from '../../application/use-cases/publish-outbox';
import type { ReprocessPendingReferences } from '../../application/use-cases/reprocess-pending-references';

/** Laço periódico com parada graciosa: stop() espera a iteração em andamento terminar. */
export class PeriodicWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<number>, // retorna "trabalho feito": >0 => repete sem dormir
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let did = 0;
        try {
          did = await this.tick();
        } catch (error) {
          this.logger.error('worker.tick_failed', { worker: this.name, error: error instanceof Error ? error.message : String(error) });
        }
        if (!this.running) break;
        if (did === 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, this.intervalMs);
            this.wake = () => { clearTimeout(t); resolve(); };
          });
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }
}

export function outboxWorker(publish: PublishOutbox, batch: number, intervalMs: number, logger: AppLogger) {
  return new PeriodicWorker('outbox', intervalMs, async () => (await publish.runBatch(batch)).published, logger);
}

export function referenceWorker(reprocess: ReprocessPendingReferences, batch: number, intervalMs: number, logger: AppLogger) {
  return new PeriodicWorker('reference-retry', intervalMs, () => reprocess.runBatch(batch), logger);
}

/** Atualiza as métricas de lag da outbox (pendentes e idade do mais antigo). */
export function outboxLagWorker(reads: ReadModel, clock: Clock, metrics: Metrics, logger: AppLogger) {
  return new PeriodicWorker('outbox-lag', 5_000, async () => {
    const stats = await reads.outboxStats(clock.now());
    metrics.outboxLag(stats.pending, stats.oldestAgeSeconds);
    return 0;
  }, logger);
}
