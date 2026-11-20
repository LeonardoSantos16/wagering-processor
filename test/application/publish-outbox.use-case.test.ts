import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createTemporaryDatabase, rawSql, type TemporaryDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import { createTestQueues, drainEvents, type PublishedEvent, type TestQueues, testSqsClient } from '../support/sqs';
import { defaultUnitOfWork } from '../support/wagering';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import { PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox.use-case';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import type { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';

describe('PublishOutboxUseCase', () => {
  const start = new Date('2026-01-01T10:00:00.000Z');
  let current = start;
  const clock = { now: () => current };

  let database: TemporaryDatabase;
  let unitOfWork: MikroOrmUnitOfWork;
  let sqs: SQSClient;
  let queues: TestQueues;

  const sqsPublisher = (queueName = queues.queueName) => new SqsEventPublisher(sqs, { queueName, timeoutMs: 5_000 });
  const useCaseWith = (publisher: EventPublisher) => new PublishOutboxUseCase(unitOfWork, publisher, clock);

  const enqueue = async (count: number, overrides: { nextAttemptAt?: Date; publishedAt?: Date } = {}) => {
    const messages = Array.from({ length: count }, (_, i) => {
      const id = randomUUID();
      return OutboxMessage.rehydrate({
        id,
        aggregateId: randomUUID(),
        eventType: 'WagerTransactionProcessed',
        payload: { eventId: id, eventType: 'WagerTransactionProcessed', data: { index: i } },
        occurredAt: new Date(start.getTime() + i),
        attempts: 0,
        ...overrides,
      });
    });
    await unitOfWork.run(async ({ outbox }) => {
      for (const message of messages) {
        await outbox.save(message);
      }
    });
    return messages;
  };
  const reload = async (message: OutboxMessage) =>
    (await unitOfWork.run(({ outbox }) => outbox.findById(message.id)))!;
  const pendingCount = async () =>
    Number(
      ((await rawSql(database.orm, 'select count(*) as count from outbox_message where published_at is null')) as {
        count: string;
      }[])[0]!.count,
    );
  const receiveAll = (expected: number) => {
    const received = new Map<string, PublishedEvent>();
    return eventually(
      async () => {
        for (const event of await drainEvents(sqs, queues.queueUrl)) {
          received.set(String(event.body.eventId), event);
        }
        return received.size >= expected && received;
      },
      { timeoutMs: 20_000 },
    );
  };

  beforeAll(async () => {
    database = await createTemporaryDatabase('wagering_outbox');
    unitOfWork = defaultUnitOfWork(database.orm);
    sqs = testSqsClient();
  });

  beforeEach(async () => {
    current = start;
    await rawSql(database.orm, 'delete from outbox_message');
    queues = await createTestQueues(sqs);
  });

  afterEach(async () => {
    await queues.remove();
  });

  afterAll(async () => {
    sqs.destroy();
    await database.drop();
  });

  test('publishes the due events to the FIFO queue and marks them as published', async () => {
    const [message] = await enqueue(1);

    current = new Date(start.getTime() + 5_000);
    const result = await useCaseWith(sqsPublisher()).execute(10);

    expect(result).toEqual({ claimed: 1, published: 1, failures: [] });
    const stored = await reload(message!);
    expect(stored.publishedAt).toEqual(current);
    expect(stored.nextAttemptAt).toBeUndefined();

    const received = await receiveAll(1);
    expect(received.get(message!.id)).toEqual({
      body: { ...message!.payload },
      groupId: message!.aggregateId,
      deduplicationId: message!.id,
      eventType: 'WagerTransactionProcessed',
    });
  });

  test('claims only pending events whose next attempt is due, oldest first, up to the limit', async () => {
    const due = await enqueue(3);
    await enqueue(1, { nextAttemptAt: new Date(start.getTime() + 60_000) });
    await enqueue(1, { publishedAt: start });

    const result = await useCaseWith(sqsPublisher()).execute(2);

    expect(result.claimed).toBe(2);
    expect((await reload(due[0]!)).isPending()).toBe(false);
    expect((await reload(due[1]!)).isPending()).toBe(false);
    expect((await reload(due[2]!)).isPending()).toBe(true);
    expect(await pendingCount()).toBe(2);
  });

  test('schedules a retry with backoff when SQS cannot be reached', async () => {
    const [message] = await enqueue(1);
    const publishToMissingQueue = useCaseWith(sqsPublisher(`missing-${randomUUID()}.fifo`));

    const first = await publishToMissingQueue.execute(10);
    current = new Date(start.getTime() + 1_000);
    await publishToMissingQueue.execute(10);

    expect(first.failures.map((failure) => failure.id)).toEqual([message!.id]);
    const stored = await reload(message!);
    expect(stored.isPending()).toBe(true);
    expect(stored.attempts).toBe(2);
    expect(stored.nextAttemptAt).toEqual(new Date(start.getTime() + 1_000 + 2_000));
  });

  test('a partial failure retries only the events that were not published', async () => {
    const [ok, failed] = await enqueue(2);
    const partial: EventPublisher = {
      publish: async () => ({ published: [ok!.id], failures: [{ id: failed!.id, reason: 'Throttled' }] }),
    };

    await useCaseWith(partial).execute(10);

    expect((await reload(ok!)).isPending()).toBe(false);
    const retried = await reload(failed!);
    expect(retried.isPending()).toBe(true);
    expect(retried.attempts).toBe(1);
  });

  test('an event missing from the publisher result is treated as not published', async () => {
    const [message] = await enqueue(1);
    const silent: EventPublisher = { publish: async () => ({ published: [], failures: [] }) };

    await useCaseWith(silent).execute(10);

    expect((await reload(message!)).attempts).toBe(1);
  });

  test('concurrent publishers share the outbox without claiming the same event twice', async () => {
    const messages = await enqueue(60);
    const publishers = Array.from({ length: 3 }, () => useCaseWith(sqsPublisher()));

    const claimedByPublisher = await Promise.all(
      publishers.map(async (publisher) => {
        let claimed = 0;
        for (;;) {
          const result = await publisher.execute(5);
          if (result.claimed === 0) {
            return claimed;
          }
          claimed += result.claimed;
        }
      }),
    );

    expect(claimedByPublisher.reduce((sum, claimed) => sum + claimed, 0)).toBe(60);
    expect(await pendingCount()).toBe(0);
    const received = await receiveAll(60);
    expect([...received.keys()].sort()).toEqual(messages.map((message) => message.id).sort());
  });
});
