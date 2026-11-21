import { describe, expect, test } from 'bun:test';
import { ExternalTransactionConflictError } from '../../src/application/errors/persistence.errors';
import {
  IdempotencyConflictError,
  InboxMessageConflictError,
  WalletNotFoundError,
} from '../../src/application/errors/wager-transaction.errors';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../src/application/use-cases/process-wager-transaction.use-case';
import type { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { InstrumentedProcessWagerTransaction } from '../../src/infrastructure/metrics/instrumented-process-wager-transaction';
import { metricValue, testMetrics } from '../support/metrics';

const command = {} as ProcessWagerTransactionCommand;

const resultWith = (status: string, idempotentReplay: boolean): ProcessWagerTransactionResult => ({
  transaction: { id: 'tx-1', walletId: 'wallet-1', status } as unknown as WagerTransaction,
  idempotentReplay,
});

describe('InstrumentedProcessWagerTransaction', () => {
  const instrumented = (execute: () => Promise<ProcessWagerTransactionResult>) => {
    const metrics = testMetrics();
    return { metrics, useCase: new InstrumentedProcessWagerTransaction({ execute }, metrics) };
  };

  test('counts new transactions by status and records the duration', async () => {
    const { metrics, useCase } = instrumented(async () => resultWith('PROCESSED', false));

    await useCase.execute(command);
    await useCase.execute(command);

    expect(await metricValue(metrics, 'wagering_transactions_total', { status: 'PROCESSED' })).toBe(2);
    expect(await metricValue(metrics, 'wagering_duplicates_total')).toBeUndefined();
    expect(await metricValue(metrics, 'wagering_processing_duration_seconds', { le: '+Inf' })).toBe(2);
  });

  test('counts a replay as a duplicate, not as a new transaction', async () => {
    const { metrics, useCase } = instrumented(async () => resultWith('PROCESSED', true));

    await useCase.execute(command);

    expect(await metricValue(metrics, 'wagering_duplicates_total', { type: 'replay' })).toBe(1);
    expect(await metricValue(metrics, 'wagering_transactions_total')).toBeUndefined();
  });

  test.each([
    ['idempotency_conflict', new IdempotencyConflictError()],
    ['external_id_conflict', new ExternalTransactionConflictError()],
    ['inbox_conflict', new InboxMessageConflictError('msg-1')],
  ])('counts a %s as a duplicate and rethrows it', async (type, error) => {
    const { metrics, useCase } = instrumented(async () => {
      throw error;
    });

    await expect(useCase.execute(command)).rejects.toBe(error);

    expect(await metricValue(metrics, 'wagering_duplicates_total', { type })).toBe(1);
    expect(await metricValue(metrics, 'wagering_processing_duration_seconds', { le: '+Inf' })).toBe(1);
  });

  test('other errors are rethrown without counting a duplicate', async () => {
    const error = new WalletNotFoundError('wallet-1');
    const { metrics, useCase } = instrumented(async () => {
      throw error;
    });

    await expect(useCase.execute(command)).rejects.toBe(error);

    expect(await metricValue(metrics, 'wagering_duplicates_total')).toBeUndefined();
  });
});

describe('WageringMetrics gauges', () => {
  test('a gauge whose source fails reports NaN and the others are still collected', async () => {
    const metrics = testMetrics({
      dlqMessages: async () => {
        throw new Error('queue unavailable');
      },
      outboxLagSeconds: async () => 12,
    });

    const body = await metrics.registry.metrics();

    expect(body).toContain('wagering_dlq_messages Nan');
    expect(body).toContain('wagering_outbox_lag_seconds 12');
  });
});
