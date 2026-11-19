import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import { WalletBalanceChanged } from '../events/wallet-balance-changed';
import { Money } from '../money/money';
import { Wallet } from '../wallet/wallet';
import { OutboxMessage } from './outbox-message';

const T0 = new Date('2026-11-19T15:00:00.000Z');

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

function event() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    now: T0,
  });
  const entry = wallet.debit({
    amount: Money.from({ amount: '25.00', currency: 'BRL' }),
    transactionId: 'tx-1',
    entryId: 'entry-1',
    now: T0,
  });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'event-1',
    correlationId: 'correlation-1',
    occurredAt: T0,
  });
}

describe('OutboxMessage', () => {
  describe('enqueue', () => {
    test('stores the serialized event, identified by the eventId', () => {
      const source = event();

      const message = OutboxMessage.enqueue(source);

      expect(message.id).toBe('event-1');
      expect(message.aggregateId).toBe('wallet-1');
      expect(message.eventType).toBe('WalletBalanceChanged');
      expect(message.occurredAt).toEqual(T0);
      expect(message.payload).toEqual(source.toJSON() as unknown as Record<string, unknown>);
      expect(message.attempts).toBe(0);
      expect(message.nextAttemptAt).toBeUndefined();
      expect(message.publishedAt).toBeUndefined();
    });

    test('the payload is plain JSON and immutable', () => {
      const message = OutboxMessage.enqueue(event());

      expect(JSON.parse(JSON.stringify(message.payload))).toEqual(message.payload);
      expect(Object.isFrozen(message.payload)).toBe(true);
    });

    test('is pending and due immediately', () => {
      const message = OutboxMessage.enqueue(event());

      expect(message.isPending()).toBe(true);
      expect(message.isDue(T0)).toBe(true);
    });
  });

  describe('scheduleRetry', () => {
    test('counts the attempt and backs off exponentially (1s, 2s, 4s...)', () => {
      const message = OutboxMessage.enqueue(event());

      message.scheduleRetry(T0);
      expect(message.attempts).toBe(1);
      expect(message.nextAttemptAt).toEqual(at(1_000));

      message.scheduleRetry(at(1_000));
      expect(message.attempts).toBe(2);
      expect(message.nextAttemptAt).toEqual(at(3_000));

      message.scheduleRetry(at(3_000));
      expect(message.attempts).toBe(3);
      expect(message.nextAttemptAt).toEqual(at(7_000));
    });

    test('the delay is capped at 60s and the message never gives up', () => {
      const message = OutboxMessage.enqueue(event());

      for (let i = 0; i < 20; i++) {
        message.scheduleRetry(T0);
      }

      expect(message.attempts).toBe(20);
      expect(message.nextAttemptAt).toEqual(at(60_000));
      expect(message.isPending()).toBe(true);
    });

    test('is not due before the next attempt, and due from then on', () => {
      const message = OutboxMessage.enqueue(event());
      message.scheduleRetry(T0);

      expect(message.isDue(at(999))).toBe(false);
      expect(message.isDue(at(1_000))).toBe(true);
      expect(message.isDue(at(5_000))).toBe(true);
    });
  });

  describe('markPublished', () => {
    test('records the publication and leaves the pending set', () => {
      const message = OutboxMessage.enqueue(event());

      message.markPublished(at(10));

      expect(message.publishedAt).toEqual(at(10));
      expect(message.isPending()).toBe(false);
      expect(message.isDue(at(10))).toBe(false);
    });

    test('publishing twice is an invariant violation', () => {
      const message = OutboxMessage.enqueue(event());
      message.markPublished(at(10));

      expect(() => message.markPublished(at(20))).toThrow(InvariantViolationError);
    });

    test('a published message cannot be scheduled for retry', () => {
      const message = OutboxMessage.enqueue(event());
      message.markPublished(at(10));

      expect(() => message.scheduleRetry(at(20))).toThrow(InvariantViolationError);
    });
  });

  describe('rehydrate', () => {
    test('rebuilds the persisted state as is', () => {
      const message = OutboxMessage.rehydrate({
        id: 'event-1',
        aggregateId: 'wallet-1',
        eventType: 'WalletBalanceChanged',
        payload: { eventId: 'event-1' },
        occurredAt: T0,
        attempts: 3,
        nextAttemptAt: at(7_000),
      });

      expect(message.attempts).toBe(3);
      expect(message.nextAttemptAt).toEqual(at(7_000));
      expect(message.isDue(at(6_999))).toBe(false);
    });
  });
});
