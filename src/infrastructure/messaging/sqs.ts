import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishableEvent } from '../../application/ports/ports';
import type { AppConfig } from '../../config/config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
}

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

/**
 * Filas FIFO. ContentBasedDeduplication desligada: a deduplicação do broker usa um id explícito (messageId / eventId).
 * Isso é só OTIMIZAÇÃO — a garantia de consistência é do banco (inbox + idempotência), não do FIFO.
 */
async function ensureFifoQueue(client: SQSClient, name: string, visibilityTimeoutS: number, autoCreate: boolean): Promise<string> {
  if (!autoCreate) {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`queue ${name} not found`);
    return QueueUrl;
  }
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(visibilityTimeoutS),
      },
    }),
  );
  if (!QueueUrl) throw new Error(`could not create queue ${name}`);
  return QueueUrl;
}

export async function resolveQueues(client: SQSClient, config: AppConfig): Promise<QueueUrls> {
  const vt = config.SQS_VISIBILITY_TIMEOUT_S;
  const auto = config.SQS_AUTO_CREATE;
  const [wager, dlq, events] = await Promise.all([
    ensureFifoQueue(client, config.SQS_WAGER_QUEUE, vt, auto),
    ensureFifoQueue(client, config.SQS_WAGER_DLQ, vt, auto),
    ensureFifoQueue(client, config.SQS_EVENTS_QUEUE, vt, auto),
  ]);
  return { wager, dlq, events };
}

/** Publica eventos da outbox. MessageGroupId = aggregateId (ordem por wallet como otimização); dedup por eventId. */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(event: PublishableEvent): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(event.payload),
        MessageGroupId: event.aggregateId,
        MessageDeduplicationId: event.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: event.eventType },
          eventId: { DataType: 'String', StringValue: event.id },
        },
      }),
    );
  }
}
