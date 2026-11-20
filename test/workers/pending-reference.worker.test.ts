import { describe, expect, test } from 'bun:test';
import type {
  PendingReferenceRef,
  ResolvePendingReferenceResult,
} from '../../src/application/use-cases/resolve-pending-reference.use-case';
import { PendingReferenceWorker } from '../../src/infrastructure/workers/pending-reference.worker';

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
});
