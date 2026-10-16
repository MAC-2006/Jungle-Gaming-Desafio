import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { hashPayload } from '../../application/canonical';
import type { AppLogger, Metrics } from '../../application/ports/ports';
import type { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { parseOrThrow, sqsMessageSchema } from '../../application/schemas';
import { computeBackoffMs } from '../../domain/backoff';
import { IdempotencyConflictError, InvalidPayloadError, WalletNotFoundError } from '../../domain/errors';
import type { AppConfig } from '../../config/config';
import type { FaultInjector } from './fault-injector';

export const CONSUMER_NAME = 'wager-transactions';

type Disposition =
  | { kind: 'ack' }
  | { kind: 'dlq'; reason: string }
  | { kind: 'retry'; receiveCount: number };

/**
 * Consumer SQS. Regras:
 *  - ACK (DeleteMessage) SOMENTE depois do COMMIT do banco.
 *  - Resultado de NEGÓCIO (inclusive REJECTED e PENDING_REFERENCE) é terminal/estável => ack.
 *  - Erro PERMANENTE (payload inválido, conflito de idempotência, wallet inexistente) => DLQ imediata.
 *  - Erro TRANSITÓRIO => não deleta; visibilidade com backoff exponencial; após maxReceiveCount => FAILED + DLQ.
 *  - Mensagens de MessageGroupIds diferentes rodam em paralelo; dentro do mesmo grupo, em ordem.
 */
export class WagerSqsConsumer {
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
    private readonly processor: ProcessWagerTransaction,
    private readonly config: Pick<
      AppConfig,
      'SQS_WAIT_TIME_S' | 'SQS_BATCH_SIZE' | 'SQS_MAX_RECEIVE_COUNT' | 'SQS_RETRY_BASE_S' | 'SQS_RETRY_CAP_S' | 'SQS_VISIBILITY_TIMEOUT_S'
    >,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly faults: FaultInjector,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Para de receber e espera o lote em andamento terminar (graceful shutdown). */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const { Messages } = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: this.config.SQS_BATCH_SIZE,
            WaitTimeSeconds: this.config.SQS_WAIT_TIME_S,
            VisibilityTimeout: this.config.SQS_VISIBILITY_TIMEOUT_S,
            AttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
        );
        if (Messages?.length) await this.handleBatch(Messages);
      } catch (error) {
        this.logger.error('sqs.receive_failed', { error: error instanceof Error ? error.message : String(error) });
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const g = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'none';
      groups.set(g, [...(groups.get(g) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) await this.handleMessage(message);
      }),
    );
  }

  async handleMessage(message: Message): Promise<void> {
    const started = Date.now();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let body: unknown;
    let disposition: Disposition;
    let correlationId = message.MessageId ?? 'unknown';

    try {
      body = JSON.parse(message.Body ?? '');
    } catch {
      return this.finish(message, { kind: 'dlq', reason: 'MALFORMED_JSON' }, body, correlationId);
    }

    let envelope: ReturnType<typeof sqsMessageSchema.parse>;
    try {
      envelope = parseOrThrow(sqsMessageSchema, body, 'sqs message');
    } catch {
      return this.finish(message, { kind: 'dlq', reason: 'INVALID_ENVELOPE' }, body, correlationId);
    }
    correlationId = envelope.correlationId ?? envelope.messageId;
    const { idempotencyKey, ...payload } = envelope.data;
    // Campos de identificação para logs (nunca valores financeiros).
    const ids = {
      correlationId,
      messageId: envelope.messageId,
      walletId: typeof payload.walletId === 'string' ? payload.walletId : undefined,
      providerId: typeof payload.providerId === 'string' ? payload.providerId : undefined,
    };

    try {
      const result = await this.processor.execute(payload, idempotencyKey, {
        correlationId,
        source: 'sqs',
        inbox: { consumerName: CONSUMER_NAME, messageId: envelope.messageId, payloadHash: hashPayload(envelope.data) },
      });
      this.logger.info('sqs.message_processed', {
        ...ids,
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
        duplicateMessage: result.duplicateMessage ?? false,
        idempotentReplay: result.idempotentReplay,
        receiveCount,
      });
      disposition = { kind: 'ack' };
      this.faults.afterCommitBeforeAck(); // testes: morre aqui => a mensagem volta e o inbox absorve a duplicata
    } catch (error) {
      disposition = this.classify(error, receiveCount);
      this.logger.warn('sqs.message_failed', {
        ...ids,
        disposition: disposition.kind,
        receiveCount,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }

    if (disposition.kind === 'dlq' && disposition.reason === 'MAX_RETRIES') {
      // Melhor esforço: deixa o FAILED auditável no banco antes de ir para a DLQ.
      await this.processor.recordPermanentFailure(payload, idempotencyKey, correlationId).catch((e) =>
        this.logger.error('sqs.record_failed_error', { correlationId, error: e instanceof Error ? e.message : String(e) }),
      );
    }
    await this.finish(message, disposition, body, correlationId);
    this.metrics.processingSeconds('sqs', (Date.now() - started) / 1000);
  }

  private classify(error: unknown, receiveCount: number): Disposition {
    if (
      error instanceof InvalidPayloadError ||
      error instanceof IdempotencyConflictError ||
      error instanceof WalletNotFoundError
    ) {
      return { kind: 'dlq', reason: (error as { code: string }).code };
    }
    // TransientInfrastructureError ou qualquer erro inesperado: tenta de novo até o limite.
    if (receiveCount >= this.config.SQS_MAX_RECEIVE_COUNT) return { kind: 'dlq', reason: 'MAX_RETRIES' };
    return { kind: 'retry', receiveCount };
  }

  private async finish(message: Message, disposition: Disposition, body: unknown, correlationId: string): Promise<void> {
    try {
      if (disposition.kind === 'ack') {
        await this.delete(message);
      } else if (disposition.kind === 'dlq') {
        await this.moveToDlq(message, disposition.reason, body);
        await this.delete(message);
        this.metrics.dlq(disposition.reason);
      } else {
        const delayS = Math.min(
          this.config.SQS_VISIBILITY_TIMEOUT_S * 4,
          Math.ceil(computeBackoffMs(disposition.receiveCount - 1, {
            baseMs: this.config.SQS_RETRY_BASE_S * 1000,
            capMs: this.config.SQS_RETRY_CAP_S * 1000,
          }) / 1000),
        );
        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle!,
            VisibilityTimeout: delayS,
          }),
        );
        this.metrics.retry('sqs');
      }
    } catch (error) {
      // Falha ao dar ack/mover: a mensagem reaparece e o inbox/idempotência absorvem a duplicata.
      this.logger.error('sqs.disposition_failed', {
        correlationId,
        disposition: disposition.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async delete(message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle! }));
  }

  private async moveToDlq(message: Message, reason: string, _body: unknown): Promise<void> {
    const logicalId = (() => {
      try {
        return (JSON.parse(message.Body ?? '') as { messageId?: string }).messageId;
      } catch {
        return undefined;
      }
    })();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: `${logicalId ?? message.MessageId}:${message.Attributes?.ApproximateReceiveCount ?? '0'}:${reason}`,
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
          originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
          receiveCount: { DataType: 'String', StringValue: message.Attributes?.ApproximateReceiveCount ?? '0' },
        },
      }),
    );
  }
}
