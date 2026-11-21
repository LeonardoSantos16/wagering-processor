import { Logger } from '@nestjs/common';
import { pause } from '../system/pause';

export interface PollingCycleResult {
  full: boolean;
  failed: boolean;
}

export interface PollingLoopOptions {
  name: string;
  intervalMs: number;
  jitterRatio?: number;
  shutdownTimeoutMs?: number;
}

const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export class PollingLoop {
  private readonly logger: Logger;
  private readonly jitterRatio: number;
  private readonly shutdownTimeoutMs: number;
  private stopping: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly cycle: () => Promise<PollingCycleResult>,
    private readonly options: PollingLoopOptions,
  ) {
    this.logger = new Logger(options.name);
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  start(): void {
    if (this.loop) {
      return;
    }
    const stopping = new AbortController();
    this.stopping = stopping;
    this.loop = this.run(stopping.signal);
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    if (!loop) {
      return;
    }
    this.stopping!.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.shutdownTimeoutMs);
    });
    const outcome = await Promise.race([loop.then(() => 'done' as const), timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.logger.warn({ msg: 'stopped before the in-flight batch finished' });
    }
    this.loop = undefined;
    this.stopping = undefined;
  }

  private async run(stopping: AbortSignal): Promise<void> {
    while (!stopping.aborted) {
      let result: PollingCycleResult;
      try {
        result = await this.cycle();
      } catch (error) {
        this.logger.error({ msg: 'polling cycle failed', error: describeError(error) });
        result = { full: false, failed: true };
      }
      if (result.full && !result.failed) {
        continue;
      }
      await pause(this.jittered(this.options.intervalMs), stopping);
    }
  }

  private jittered(ms: number): number {
    const factor = 1 + (Math.random() * 2 - 1) * this.jitterRatio;
    return Math.round(ms * factor);
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
