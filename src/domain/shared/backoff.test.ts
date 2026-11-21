import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import { computeBackoffDelay } from './backoff';

describe('computeBackoffDelay', () => {
  test.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [4, 8_000],
    [6, 32_000],
  ])('attempt %i waits %i ms (base 1s, doubling)', (attempt, expected) => {
    expect(computeBackoffDelay(attempt, 1_000, 60_000)).toBe(expected);
  });

  test('is capped at the maximum delay', () => {
    expect(computeBackoffDelay(7, 1_000, 60_000)).toBe(60_000);
    expect(computeBackoffDelay(500, 1_000, 60_000)).toBe(60_000);
  });

  test('rejects an attempt lower than 1', () => {
    expect(() => computeBackoffDelay(0, 1_000, 60_000)).toThrow(InvariantViolationError);
  });
});
