import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Services } from './composition';
import { createFaultInjector } from './infrastructure/messaging/fault-injector';
import { QueueUrls, SqsEventPublisher, createSqsClient, resolveQueues } from './infrastructure/messaging/sqs';
import { WagerSqsConsumer } from './infrastructure/messaging/wager-consumer';
import { PeriodicWorker, outboxLagWorker, outboxWorker, referenceWorker } from './infrastructure/messaging/workers';

export interface Runtime {
  sqs: { client: SQSClient; urls: QueueUrls };
  consumer?: WagerSqsConsumer;
  workers: PeriodicWorker[];
  start(): void;
  /** Graceful: para de receber, conclui o que está em andamento e só então libera as conexões. */
  stop(): Promise<void>;
}

export async function buildRuntime(services: Services): Promise<Runtime> {
  const { config } = services;
  const client = createSqsClient(config);
  const urls = await resolveQueues(client, config);
  const enabled = config.ENABLE_WORKERS;

  const consumer =
    enabled && config.ENABLE_SQS_CONSUMER
      ? new WagerSqsConsumer(client, urls.wager, urls.dlq, services.processWager, config, services.metrics, services.logger, createFaultInjector(config))
      : undefined;

  const workers: PeriodicWorker[] = [];
  if (enabled && config.ENABLE_OUTBOX_PUBLISHER) {
    const publish = services.makeOutboxPublisher(new SqsEventPublisher(client, urls.events));
    workers.push(outboxWorker(publish, config.OUTBOX_BATCH_SIZE, config.OUTBOX_POLL_INTERVAL_MS, services.logger));
    workers.push(outboxLagWorker(services.reads, services.clock, services.metrics, services.logger));
  }
  if (enabled && config.ENABLE_REFERENCE_WORKER) {
    workers.push(referenceWorker(services.reprocessReferences, config.REFERENCE_BATCH_SIZE, config.REFERENCE_POLL_INTERVAL_MS, services.logger));
  }

  return {
    sqs: { client, urls },
    ...(consumer ? { consumer } : {}),
    workers,
    start() {
      consumer?.start();
      workers.forEach((w) => w.start());
    },
    async stop() {
      await consumer?.stop();
      await Promise.all(workers.map((w) => w.stop()));
      client.destroy();
    },
  };
}
