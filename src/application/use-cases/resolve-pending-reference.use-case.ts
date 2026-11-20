import { FailureCode } from '../../domain/errors/failure-code';
import { InvariantViolationError } from '../../domain/errors/invariant-violation.error';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import { WalletNotFoundError } from '../errors/wager-transaction.errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { PendingReferencePolicy } from '../services/pending-reference-policy';
import { type Outcome, WagerTransactionResolver } from '../services/wager-transaction-resolver';

export interface PendingReferenceRef {
  transactionId: string;
  walletId: string;
}

export type PendingReferenceOutcome = 'resolved' | 'rescheduled' | 'skipped';

export interface ResolvePendingReferenceResult {
  outcome: PendingReferenceOutcome;
  transaction?: WagerTransaction;
}

export class ResolvePendingReferenceUseCase {
  private readonly resolver: WagerTransactionResolver;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: PendingReferencePolicy,
  ) {
    this.resolver = new WagerTransactionResolver(ids);
  }

  async findDue(limit: number): Promise<PendingReferenceRef[]> {
    const now = this.clock.now();
    const due = await this.unitOfWork.run(({ transactions }) => transactions.findDuePendingReferences(now, limit));
    return due.map((transaction) => ({ transactionId: transaction.id, walletId: transaction.walletId }));
  }

  execute(ref: PendingReferenceRef): Promise<ResolvePendingReferenceResult> {
    const now = this.clock.now();

    return this.unitOfWork.run(async (repositories) => {
      const { wallets, transactions } = repositories;
      const wallet = await wallets.findByIdForUpdate(ref.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(ref.walletId);
      }

      const transaction = await transactions.findById(ref.transactionId);
      if (!transaction || !isDue(transaction, now)) {
        return { outcome: 'skipped', transaction: transaction ?? undefined };
      }
      const providerId = transaction.provider?.providerId;
      if (providerId === undefined) {
        throw new InvariantViolationError(`pending transaction ${transaction.id} has no provider`);
      }

      const correlationId = transaction.id;
      const decision = await this.resolver.decide(transaction, wallet, providerId, transactions);
      let outcome: Outcome;
      if (decision.type !== 'missingReference') {
        outcome = this.resolver.apply(transaction, wallet, decision, now, correlationId);
      } else if (this.policy.isExpired(transaction, now)) {
        const expired = { type: 'reject', code: FailureCode.ReferenceNotFound } as const;
        outcome = this.resolver.apply(transaction, wallet, expired, now, correlationId);
      } else {
        transaction.scheduleReferenceRetry(this.policy.retryAttemptAt(transaction, now));
        await transactions.save(transaction);
        return { outcome: 'rescheduled', transaction };
      }

      await this.resolver.persist(repositories, transaction, wallet, outcome);
      return { outcome: 'resolved', transaction };
    });
  }
}

function isDue(transaction: WagerTransaction, now: Date): boolean {
  return (
    transaction.status === WagerTransactionStatus.PendingReference &&
    transaction.nextReferenceAttemptAt !== undefined &&
    transaction.nextReferenceAttemptAt.getTime() <= now.getTime()
  );
}
