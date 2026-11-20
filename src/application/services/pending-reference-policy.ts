import { computeBackoffDelay } from '../../domain/shared/backoff';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';

export interface PendingReferencePolicyOptions {
  ttlMs: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

type PendingTransaction = Pick<WagerTransaction, 'createdAt' | 'referenceAttempts'>;

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

export class PendingReferencePolicy {
  private readonly ttlMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: PendingReferencePolicyOptions) {
    if (!Number.isInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error(`Invalid pending reference TTL: ${options.ttlMs}`);
    }
    this.ttlMs = options.ttlMs;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  deadlineOf(transaction: PendingTransaction): Date {
    return new Date(transaction.createdAt.getTime() + this.ttlMs);
  }

  isExpired(transaction: PendingTransaction, now: Date): boolean {
    return now.getTime() >= this.deadlineOf(transaction).getTime();
  }

  firstAttemptAt(transaction: PendingTransaction, now: Date): Date {
    return this.attemptAt(transaction, 1, now);
  }

  retryAttemptAt(transaction: PendingTransaction, now: Date): Date {
    return this.attemptAt(transaction, transaction.referenceAttempts + 2, now);
  }

  private attemptAt(transaction: PendingTransaction, attempt: number, now: Date): Date {
    const delay = computeBackoffDelay(attempt, this.baseDelayMs, this.maxDelayMs);
    const next = now.getTime() + delay;
    return new Date(Math.min(next, this.deadlineOf(transaction).getTime()));
  }
}
