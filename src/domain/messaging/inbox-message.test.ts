import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import { InboxMessage } from './inbox-message';

const RECEIVED_AT = new Date('2026-11-19T15:00:00.000Z');
const PROCESSED_AT = new Date('2026-11-19T15:00:00.050Z');

function receive() {
  return InboxMessage.receive({
    messageId: 'msg-123',
    consumerName: 'wager-transactions',
    payloadHash: 'hash-a',
    receivedAt: RECEIVED_AT,
  });
}

describe('InboxMessage', () => {
  test('a received message is not processed yet', () => {
    const message = receive();

    expect(message.messageId).toBe('msg-123');
    expect(message.consumerName).toBe('wager-transactions');
    expect(message.payloadHash).toBe('hash-a');
    expect(message.receivedAt).toEqual(RECEIVED_AT);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('markProcessed records when it was processed', () => {
    const message = receive();

    message.markProcessed(PROCESSED_AT);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(PROCESSED_AT);
  });

  test('processing twice is an invariant violation', () => {
    const message = receive();
    message.markProcessed(PROCESSED_AT);

    expect(() => message.markProcessed(PROCESSED_AT)).toThrow(InvariantViolationError);
  });

  test('matchesPayload detects the same messageId with a different content', () => {
    const message = receive();

    expect(message.matchesPayload('hash-a')).toBe(true);
    expect(message.matchesPayload('hash-b')).toBe(false);
  });

  test('rehydrate rebuilds the persisted state as is', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-123',
      consumerName: 'wager-transactions',
      payloadHash: 'hash-a',
      receivedAt: RECEIVED_AT,
      processedAt: PROCESSED_AT,
    });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(PROCESSED_AT);
  });
});
