import { Logger } from '@nestjs/common';
import type { ResolvePendingReferenceUseCase } from '../../application/use-cases/resolve-pending-reference.use-case';
import { describeError, type PollingCycleResult } from './polling-loop';

export interface PendingReferenceWorkerOptions {
  batchSize: number;
}

export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);

  constructor(
    private readonly resolvePendingReference: Pick<ResolvePendingReferenceUseCase, 'findDue' | 'execute'>,
    private readonly options: PendingReferenceWorkerOptions,
  ) {}

  async runOnce(): Promise<PollingCycleResult> {
    const due = await this.resolvePendingReference.findDue(this.options.batchSize);
    let failed = false;
    for (const ref of due) {
      const context = { transactionId: ref.transactionId, walletId: ref.walletId };
      try {
        const { outcome, transaction } = await this.resolvePendingReference.execute(ref);
        this.logger.log({
          msg: 'pending reference attempt finished',
          ...context,
          providerId: transaction?.provider?.providerId,
          outcome,
          status: transaction?.status,
          failureCode: transaction?.failureCode,
          referenceAttempts: transaction?.referenceAttempts,
        });
      } catch (error) {
        failed = true;
        this.logger.warn({ msg: 'pending reference attempt failed', ...context, error: describeError(error) });
      }
    }
    return { full: due.length === this.options.batchSize, failed };
  }
}
