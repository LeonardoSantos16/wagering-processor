import { describe, expect, test } from 'bun:test';
import type { PublishOutboxResult } from '../../src/application/use-cases/publish-outbox.use-case';
import { OutboxPublisherWorker } from '../../src/infrastructure/workers/outbox-publisher.worker';
import { metricValue, testMetrics } from '../support/metrics';

describe('OutboxPublisherWorker', () => {
  const workerReturning = (result: PublishOutboxResult) =>
    new OutboxPublisherWorker({ execute: async () => result }, { batchSize: 10 });

  test('reports a full batch when it claimed as many events as the batch size', async () => {
    expect(await workerReturning({ claimed: 10, published: 10, failures: [] }).runOnce()).toEqual({
      full: true,
      failed: false,
    });
    expect(await workerReturning({ claimed: 4, published: 4, failures: [] }).runOnce()).toEqual({
      full: false,
      failed: false,
    });
  });

  test('marks the cycle as failed when any event was not published', async () => {
    const result = { claimed: 10, published: 9, failures: [{ id: 'event-1', reason: 'Throttled' }] };

    expect(await workerReturning(result).runOnce()).toEqual({ full: true, failed: true });
  });

  test('counts one outbox retry per event that was not published', async () => {
    const metrics = testMetrics();
    const failures = [
      { id: 'event-1', reason: 'Throttled' },
      { id: 'event-2', reason: 'Throttled' },
    ];
    const worker = new OutboxPublisherWorker(
      { execute: async () => ({ claimed: 5, published: 3, failures }) },
      { batchSize: 10 },
      metrics,
    );

    await worker.runOnce();

    expect(await metricValue(metrics, 'wagering_retries_total', { component: 'outbox_publisher' })).toBe(2);
  });
});
