import { Logger } from '@nestjs/common';
import { ExternalTransactionConflictError } from '../../application/errors/persistence.errors';
import {
  IdempotencyConflictError,
  InboxMessageConflictError,
} from '../../application/errors/wager-transaction.errors';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case';
import type { DuplicateType, WageringMetrics } from './wagering-metrics';

export class InstrumentedProcessWagerTransaction implements Pick<ProcessWagerTransactionUseCase, 'execute'> {
  private readonly logger = new Logger('ProcessWagerTransaction');

  constructor(
    private readonly useCase: Pick<ProcessWagerTransactionUseCase, 'execute'>,
    private readonly metrics: WageringMetrics,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const stopTimer = this.metrics.processingDuration.startTimer();
    try {
      const result = await this.useCase.execute(command);
      this.record(command, result);
      return result;
    } catch (error) {
      const type = duplicateTypeOf(error);
      if (type) {
        this.metrics.duplicates.inc({ type });
      }
      throw error;
    } finally {
      stopTimer();
    }
  }

  private record(command: ProcessWagerTransactionCommand, { transaction, idempotentReplay }: ProcessWagerTransactionResult) {
    if (idempotentReplay) {
      this.metrics.duplicates.inc({ type: 'replay' });
    } else {
      this.metrics.transactions.inc({ status: transaction.status });
    }
    this.logger.log({
      msg: 'wager transaction processed',
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.provider?.providerId,
      messageId: command.inbox?.messageId,
      status: transaction.status,
      idempotentReplay,
    });
  }
}

function duplicateTypeOf(error: unknown): DuplicateType | undefined {
  if (error instanceof IdempotencyConflictError) {
    return 'idempotency_conflict';
  }
  if (error instanceof ExternalTransactionConflictError) {
    return 'external_id_conflict';
  }
  if (error instanceof InboxMessageConflictError) {
    return 'inbox_conflict';
  }
  return undefined;
}
