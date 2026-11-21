import { Logger } from '@nestjs/common';
import type { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.use-case';
import type { WageringMetrics } from '../metrics/wagering-metrics';
import type { PollingCycleResult } from './polling-loop';

export interface OutboxPublisherWorkerOptions {
  batchSize: number;
}

export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);

  constructor(
    private readonly publishOutbox: Pick<PublishOutboxUseCase, 'execute'>,
    private readonly options: OutboxPublisherWorkerOptions,
    private readonly metrics?: WageringMetrics,
  ) {}

  async runOnce(): Promise<PollingCycleResult> {
    const { claimed, published, failures } = await this.publishOutbox.execute(this.options.batchSize);
    if (claimed > 0) {
      this.logger.log({ msg: 'outbox batch published', claimed, published, failed: failures.length });
    }
    if (failures.length > 0) {
      this.metrics?.retries.inc({ component: 'outbox_publisher' }, failures.length);
    }
    for (const failure of failures) {
      this.logger.warn({ msg: 'outbox event not published, will retry', eventId: failure.id, reason: failure.reason });
    }
    return { full: claimed === this.options.batchSize, failed: failures.length > 0 };
  }
}
