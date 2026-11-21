import { describe, expect, test } from 'bun:test';
import { PendingReferencePolicy } from './pending-reference-policy';

describe('PendingReferencePolicy', () => {
  const createdAt = new Date('2026-01-01T10:00:00.000Z');
  const at = (ms: number) => new Date(createdAt.getTime() + ms);
  const policy = new PendingReferencePolicy({ ttlMs: 60 * 60_000 });

  test('the deadline is the creation time plus the TTL', () => {
    expect(policy.deadlineOf({ createdAt, referenceAttempts: 0 })).toEqual(at(60 * 60_000));
  });

  test('expires exactly at the deadline', () => {
    const transaction = { createdAt, referenceAttempts: 3 };

    expect(policy.isExpired(transaction, at(60 * 60_000 - 1))).toBe(false);
    expect(policy.isExpired(transaction, at(60 * 60_000))).toBe(true);
  });

  test('the first attempt waits the base delay', () => {
    expect(policy.firstAttemptAt({ createdAt, referenceAttempts: 0 }, createdAt)).toEqual(at(1_000));
  });

  test.each([
    [0, 2_000],
    [1, 4_000],
    [4, 32_000],
    [5, 60_000],
    [40, 60_000],
  ])('after %i retries the next one waits %i ms', (referenceAttempts, delay) => {
    const now = at(5 * 60_000);

    expect(policy.retryAttemptAt({ createdAt, referenceAttempts }, now)).toEqual(new Date(now.getTime() + delay));
  });

  test('never schedules an attempt after the deadline', () => {
    const now = at(60 * 60_000 - 500);

    expect(policy.retryAttemptAt({ createdAt, referenceAttempts: 10 }, now)).toEqual(at(60 * 60_000));
  });

  test('a TTL shorter than the base delay schedules the first attempt at the deadline', () => {
    const short = new PendingReferencePolicy({ ttlMs: 300 });

    expect(short.firstAttemptAt({ createdAt, referenceAttempts: 0 }, createdAt)).toEqual(at(300));
  });

  test.each([0, -1, 1.5])('rejects the TTL %p', (ttlMs) => {
    expect(() => new PendingReferencePolicy({ ttlMs })).toThrow('Invalid pending reference TTL');
  });
});
