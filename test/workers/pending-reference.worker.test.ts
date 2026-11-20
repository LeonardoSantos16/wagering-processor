import { describe, expect, test } from 'bun:test';
import type {
  PendingReferenceRef,
  ResolvePendingReferenceResult,
} from '../../src/application/use-cases/resolve-pending-reference.use-case';
import type { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { PendingReferenceWorker } from '../../src/infrastructure/workers/pending-reference.worker';
import { metricValue, testMetrics } from '../support/metrics';

describe('PendingReferenceWorker', () => {
  const refs = (count: number): PendingReferenceRef[] =>
    Array.from({ length: count }, (_, i) => ({ transactionId: `tx-${i}`, walletId: `wallet-${i}` }));

  const workerWith = (due: PendingReferenceRef[], failing: Set<string> = new Set()) => {
    const attempted: string[] = [];
    const worker = new PendingReferenceWorker(
      {
        findDue: async () => due,
        execute: async (ref): Promise<ResolvePendingReferenceResult> => {
          attempted.push(ref.transactionId);
          if (failing.has(ref.transactionId)) {
            throw new Error('lock timeout');
          }
          return { outcome: 'rescheduled' };
        },
      },
      { batchSize: 3 },
    );
    return { worker, attempted };
  };

  test('reports a full batch when it got as many items as the batch size', async () => {
    expect(await workerWith(refs(3)).worker.runOnce()).toEqual({ full: true, failed: false });
    expect(await workerWith(refs(2)).worker.runOnce()).toEqual({ full: false, failed: false });
  });

  test('a failing item does not stop the others and marks the cycle as failed', async () => {
    const { worker, attempted } = workerWith(refs(3), new Set(['tx-1']));

    expect(await worker.runOnce()).toEqual({ full: true, failed: true });
    expect(attempted).toEqual(['tx-0', 'tx-1', 'tx-2']);
  });

  test('counts resolved references by final status and rescheduled ones as retries', async () => {
    const metrics = testMetrics();
    const outcomes: ResolvePendingReferenceResult[] = [
      { outcome: 'resolved', transaction: { status: 'PROCESSED' } as unknown as WagerTransaction },
      { outcome: 'resolved', transaction: { status: 'REJECTED' } as unknown as WagerTransaction },
      { outcome: 'rescheduled' },
    ];
    const worker = new PendingReferenceWorker(
      { findDue: async () => refs(3), execute: async () => outcomes.shift()! },
      { batchSize: 3 },
      metrics,
    );

    await worker.runOnce();

    expect(await metricValue(metrics, 'wagering_transactions_total', { status: 'PROCESSED' })).toBe(1);
    expect(await metricValue(metrics, 'wagering_transactions_total', { status: 'REJECTED' })).toBe(1);
    expect(await metricValue(metrics, 'wagering_retries_total', { component: 'pending_reference' })).toBe(1);
  });
});
