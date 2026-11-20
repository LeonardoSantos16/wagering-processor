import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/messaging/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/messaging/mikro-orm-outbox.repository';
import { WagerTransactionRejected } from '../../src/domain/events/wager-transaction-events';
import { FailureCode } from '../../src/domain/errors/failure-code';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';

const CREATED = new Date('2026-01-01T10:00:00.000Z');
const RESOLVED = new Date('2026-01-01T10:00:01.000Z');
const LATER = new Date('2026-01-01T10:00:02.000Z');

describe('messaging repositories', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  describe('MikroOrmOutboxRepository', () => {
    const enqueue = () => {
      const transaction = WagerTransaction.create({
        id: randomUUID(),
        provider: {
          providerId: 'provider-a',
          externalTransactionId: 'tx-1',
          idempotencyKey: 'provider-a:tx-1',
          roundId: 'round-1',
          gameId: 'game-1',
        },
        walletId: randomUUID(),
        playerId: 'player-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        now: CREATED,
      });
      transaction.reject({
        code: FailureCode.InsufficientFunds,
        balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
        at: RESOLVED,
      });
      const event = WagerTransactionRejected.from(transaction, {
        eventId: randomUUID(),
        correlationId: 'correlation-1',
        occurredAt: RESOLVED,
      });
      return { message: OutboxMessage.enqueue(event), event };
    };

    const persist = async (message: OutboxMessage) => {
      const em = orm.em.fork();
      await new MikroOrmOutboxRepository(em).save(message);
      await em.flush();
    };

    test('round-trips a pending message with the event payload intact', async () => {
      const { message, event } = enqueue();
      await persist(message);

      const loaded = (await new MikroOrmOutboxRepository(orm.em.fork()).findById(message.id))!;

      expect(loaded.id).toBe(event.eventId);
      expect(loaded.aggregateId).toBe(event.aggregateId);
      expect(loaded.eventType).toBe('WagerTransactionRejected');
      expect(loaded.payload).toEqual(JSON.parse(JSON.stringify(event.toJSON())));
      expect(loaded.occurredAt).toEqual(RESOLVED);
      expect(loaded.attempts).toBe(0);
      expect(loaded.nextAttemptAt).toBeUndefined();
      expect(loaded.isPending()).toBe(true);
    });

    test('persists a retry and then the publication', async () => {
      const { message } = enqueue();
      await persist(message);

      const retryContext = orm.em.fork();
      const retryRepository = new MikroOrmOutboxRepository(retryContext);
      const retrying = (await retryRepository.findById(message.id))!;
      retrying.scheduleRetry(LATER);
      await retryRepository.save(retrying);
      await retryContext.flush();

      const afterRetry = (await new MikroOrmOutboxRepository(orm.em.fork()).findById(message.id))!;
      expect(afterRetry.attempts).toBe(1);
      expect(afterRetry.nextAttemptAt).toEqual(new Date(LATER.getTime() + 1_000));

      const publishContext = orm.em.fork();
      const publishRepository = new MikroOrmOutboxRepository(publishContext);
      const publishing = (await publishRepository.findById(message.id))!;
      publishing.markPublished(LATER);
      await publishRepository.save(publishing);
      await publishContext.flush();

      const published = (await new MikroOrmOutboxRepository(orm.em.fork()).findById(message.id))!;
      expect(published.isPending()).toBe(false);
      expect(published.publishedAt).toEqual(LATER);
      expect(published.nextAttemptAt).toBeUndefined();
    });

    test('returns null for an unknown id', async () => {
      expect(await new MikroOrmOutboxRepository(orm.em.fork()).findById(randomUUID())).toBeNull();
    });
  });

  describe('MikroOrmInboxRepository', () => {
    const CONSUMER = 'wager-transactions';

    test('round-trips a message and its processing, keyed by consumer and message id', async () => {
      const messageId = randomUUID();
      const received = InboxMessage.receive({
        messageId,
        consumerName: CONSUMER,
        payloadHash: 'c'.repeat(64),
        receivedAt: CREATED,
      });
      const em = orm.em.fork();
      const repository = new MikroOrmInboxRepository(em);
      await repository.save(received);
      await em.flush();

      const processContext = orm.em.fork();
      const processRepository = new MikroOrmInboxRepository(processContext);
      const loaded = (await processRepository.find(CONSUMER, messageId))!;
      expect(loaded.isProcessed()).toBe(false);
      expect(loaded.matchesPayload('c'.repeat(64))).toBe(true);
      expect(loaded.receivedAt).toEqual(CREATED);
      loaded.markProcessed(RESOLVED);
      await processRepository.save(loaded);
      await processContext.flush();

      const processed = (await new MikroOrmInboxRepository(orm.em.fork()).find(CONSUMER, messageId))!;
      expect(processed.processedAt).toEqual(RESOLVED);
      expect(await new MikroOrmInboxRepository(orm.em.fork()).find('other-consumer', messageId)).toBeNull();
    });
  });
});
