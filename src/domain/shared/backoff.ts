import { InvariantViolationError } from '../errors/invariant-violation.error';

export function computeBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new InvariantViolationError('backoff attempt must be an integer >= 1');
  }
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}
