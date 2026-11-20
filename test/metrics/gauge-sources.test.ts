import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { DatabaseAndQueueGaugeSources } from '../../src/infrastructure/metrics/gauge-sources';
import { createTemporaryDatabase, insertRow, rawSql, type TemporaryDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import { createTestQueues, type TestQueues, testSqsClient } from '../support/sqs';

describe('DatabaseAndQueueGaugeSources', () => {
  const sqs = testSqsClient();
  let database: TemporaryDatabase;
  let queues: TestQueues;
  let sources: DatabaseAndQueueGaugeSources;

  const outboxEvent = (occurredSecondsAgo: number, published: boolean) => {
    const occurredAt = new Date(Date.now() - occurredSecondsAgo * 1000);
    return insertRow(database.orm, 'outbox_message', {
      id: randomUUID(),
      aggregate_id: randomUUID(),
      event_type: 'WalletBalanceChanged',
      payload: '{}',
      occurred_at: occurredAt,
      attempts: 0,
      next_attempt_at: published ? null : occurredAt,
      published_at: published ? occurredAt : null,
    });
  };

  beforeAll(async () => {
    database = await createTemporaryDatabase('wagering_metrics');
    queues = await createTestQueues(sqs);
    sources = new DatabaseAndQueueGaugeSources(database.orm.em.fork() as EntityManager, sqs, queues.dlqName);
  });

  afterAll(async () => {
    await queues.remove();
    await database.drop();
  });

  beforeEach(async () => {
    await rawSql(database.orm, 'delete from outbox_message');
  });

  test('outbox lag is 0 without pending events', async () => {
    await outboxEvent(120, true);

    expect(await sources.outboxLagSeconds()).toBe(0);
  });

  test('outbox lag is the age of the oldest pending event', async () => {
    await outboxEvent(30, false);
    await outboxEvent(5, false);
    await outboxEvent(300, true);

    const lag = await sources.outboxLagSeconds();

    expect(lag).toBeGreaterThanOrEqual(29);
    expect(lag).toBeLessThan(40);
  });

  test('dlq messages reflects the messages in the dead-letter queue', async () => {
    expect(await sources.dlqMessages()).toBe(0);

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.dlqUrl,
        MessageBody: '{}',
        MessageGroupId: 'group-1',
        MessageDeduplicationId: randomUUID(),
      }),
    );

    await eventually(async () => (await sources.dlqMessages()) === 1);
  });
});
