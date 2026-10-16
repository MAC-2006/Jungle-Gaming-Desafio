import { randomUUID } from 'node:crypto';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config/config';
import { QueueUrls, createSqsClient, resolveQueues } from '../../src/infrastructure/messaging/sqs';

export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? 'http://127.0.0.1:4566';

export async function createTestQueues() {
  const prefix = `t${randomUUID().slice(0, 8)}`;
  const config = loadConfig({
    AWS_ENDPOINT_URL: SQS_ENDPOINT,
    SQS_WAGER_QUEUE: `${prefix}-wager.fifo`,
    SQS_WAGER_DLQ: `${prefix}-dlq.fifo`,
    SQS_EVENTS_QUEUE: `${prefix}-events.fifo`,
    SQS_VISIBILITY_TIMEOUT_S: '3',
    SQS_WAIT_TIME_S: '1',
    SQS_RETRY_BASE_S: '1',
    SQS_RETRY_CAP_S: '2',
    SQS_MAX_RECEIVE_COUNT: '3',
  });
  const client = createSqsClient(config);
  const urls = await resolveQueues(client, config);
  return { client, urls, config, prefix };
}

/** Mensagem no formato da seção 10 do desafio. */
export function envelope(payload: object, key: string, messageId: string = randomUUID()) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...payload, idempotencyKey: key },
  };
}

export async function sendEnvelope(
  client: SQSClient, queueUrl: string, env: object, groupId: string, dedupId: string = randomUUID(),
) {
  await client.send(new SendMessageCommand({
    QueueUrl: queueUrl, MessageBody: JSON.stringify(env), MessageGroupId: groupId, MessageDeduplicationId: dedupId,
  }));
}

export async function drain(client: SQSClient, queueUrl: string, waitS = 1, max = 100) {
  const out: Array<{ body: string; attrs: Record<string, string | undefined> }> = [];
  for (let i = 0; i < max; i += 1) {
    const r = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: waitS, MessageAttributeNames: ['All'], VisibilityTimeout: 30,
    }));
    if (!r.Messages?.length) break;
    for (const m of r.Messages) {
      out.push({ body: m.Body ?? '', attrs: Object.fromEntries(Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue])) });
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
  return out;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 20_000, everyMs = 150): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ''}`);
}

export type { QueueUrls };
