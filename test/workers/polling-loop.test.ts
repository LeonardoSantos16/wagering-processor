import { describe, expect, test } from 'bun:test';
import { type PollingCycleResult, PollingLoop } from '../../src/infrastructure/workers/polling-loop';
import { deferred } from '../support/wagering';
import { eventually } from '../support/eventually';

const LONG_INTERVAL_MS = 60_000;

describe('PollingLoop', () => {
  const loopOver = (results: PollingCycleResult[], onCycle: () => Promise<void> = async () => {}) => {
    let cycles = 0;
    const loop = new PollingLoop(
      async () => {
        await onCycle();
        return results[Math.min(cycles++, results.length - 1)]!;
      },
      { name: 'test-loop', intervalMs: LONG_INTERVAL_MS },
    );
    return { loop, cycles: () => cycles };
  };

  test('runs again right away while batches come full, then waits', async () => {
    const full = { full: true, failed: false };
    const { loop, cycles } = loopOver([full, full, { full: false, failed: false }]);

    loop.start();
    await eventually(async () => cycles() >= 3);
    await loop.stop();

    expect(cycles()).toBe(3);
  });

  test('waits the interval after a failed cycle even if the batch was full', async () => {
    const { loop, cycles } = loopOver([{ full: true, failed: true }]);

    loop.start();
    await eventually(async () => cycles() >= 1);
    await loop.stop();

    expect(cycles()).toBe(1);
  });

  test('keeps running after a cycle throws', async () => {
    let calls = 0;
    const loop = new PollingLoop(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('boom');
        }
        return { full: false, failed: false };
      },
      { name: 'test-loop', intervalMs: 10 },
    );

    loop.start();
    await eventually(async () => calls >= 2);
    await loop.stop();
  });

  test('stop waits for the in-flight cycle and does not start another', async () => {
    const release = deferred();
    const started = deferred();
    let finished = false;
    const { loop, cycles } = loopOver([{ full: true, failed: false }], async () => {
      started.resolve();
      await release.promise;
      finished = true;
    });

    loop.start();
    await started.promise;
    const stopped = loop.stop();
    release.resolve();
    await stopped;

    expect(finished).toBe(true);
    expect(cycles()).toBe(1);
  });
});
