import { Logger } from '@nestjs/common';
import type { ResolvePendingReferenceUseCase } from '../../application/use-cases/resolve-pending-reference.use-case';
import type { WageringMetrics } from '../metrics/wagering-metrics';
import { describeError, type PollingCycleResult } from './polling-loop';

export interface PendingReferenceWorkerOptions {
  batchSize: number;
}

export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);

  constructor(
    private readonly resolvePendingReference: Pick<ResolvePendingReferenceUseCase, 'findDue' | 'execute'>,
    private readonly options: PendingReferenceWorkerOptions,
    private readonly metrics?: WageringMetrics,
  ) {}

  async runOnce(): Promise<PollingCycleResult> {
    const due = await this.resolvePendingReference.findDue(this.options.batchSize);
    let failed = false;
    for (const ref of due) {
      const context = { transactionId: ref.transactionId, walletId: ref.walletId };
      try {
        const { outcome, transaction } = await this.resolvePendingReference.execute(ref);
        if (outcome === 'resolved' && transaction) {
          this.metrics?.transactions.inc({ status: transaction.status });
        } else if (outcome === 'rescheduled') {
          this.metrics?.retries.inc({ component: 'pending_reference' });
        }
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
