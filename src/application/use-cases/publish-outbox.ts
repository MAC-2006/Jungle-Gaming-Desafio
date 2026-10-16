import { BackoffPolicy } from '../../domain/backoff';
import { Clock, EventPublisher, AppLogger, Metrics, UnitOfWork } from '../ports/ports';

/**
 * Publica eventos pendentes. Entrega AT-LEAST-ONCE: se o processo cair depois de publicar e antes do commit,
 * o evento será publicado de novo — por isso o consumidor deduplica por eventId (= id da mensagem na outbox).
 * FOR UPDATE SKIP LOCKED permite vários publishers concorrentes sem pegar a mesma linha.
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly backoff: BackoffPolicy,
    /** Envios ao broker simultâneos dentro de um lote (a latência de rede, não a CPU, limita a vazão). */
    private readonly concurrency = 10,
  ) {}

  async runBatch(limit: number): Promise<{ published: number; failed: number }> {
    return this.uow.run(async (ctx) => {
      const now = this.clock.now();
      const due = await ctx.outbox.claimDue(now, limit);
      let published = 0;
      let failed = 0;
      // Envios ao broker em paralelo limitado (Promise.allSettled: a falha de um não afeta os outros).
      // As escritas no banco seguem sequenciais: todas usam a MESMA transação/conexão.
      for (let i = 0; i < due.length; i += this.concurrency) {
        const chunk = due.slice(i, i + this.concurrency);
        const outcomes = await Promise.allSettled(
          chunk.map((message) =>
            this.publisher.publish({
              id: message.id,
              aggregateId: message.aggregateId,
              eventType: message.eventType,
              payload: message.payload,
            }),
          ),
        );
        for (const [index, message] of chunk.entries()) {
          const outcome = outcomes[index]!;
          if (outcome.status === 'fulfilled') {
            message.markPublished(this.clock.now());
            await ctx.outbox.save(message);
            published += 1;
            this.metrics.outboxPublished();
          } else {
            const error = outcome.reason;
            message.scheduleRetry(this.clock.now(), this.backoff);
            await ctx.outbox.save(message, error instanceof Error ? error.message : String(error));
            failed += 1;
            this.metrics.retry('outbox');
            this.logger.warn('outbox.publish_failed', {
              eventId: message.id,
              eventType: message.eventType,
              attempts: message.attempts,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return { published, failed };
    });
  }
}
