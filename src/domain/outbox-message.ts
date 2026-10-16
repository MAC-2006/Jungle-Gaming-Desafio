import { BackoffPolicy, computeBackoffMs } from './backoff';
import type { IntegrationEvent } from './events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export const DEFAULT_OUTBOX_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 60_000 };

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId: o consumidor deduplica por ele. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial). */
  scheduleRetry(now: Date, policy: BackoffPolicy = DEFAULT_OUTBOX_BACKOFF): void {
    const delay = computeBackoffMs(this._attempts, policy);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
