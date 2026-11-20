import { Logger } from '@nestjs/common';
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import { describeError } from '../workers/polling-loop';

export type DuplicateType = 'replay' | 'idempotency_conflict' | 'external_id_conflict' | 'inbox_conflict';
export type RetryComponent = 'sqs_consumer' | 'outbox_publisher' | 'pending_reference';

export interface GaugeSources {
  outboxLagSeconds(): Promise<number>;
  dlqMessages(): Promise<number>;
}

const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

export class WageringMetrics {
  readonly transactions: Counter<'status'>;
  readonly duplicates: Counter<'type'>;
  readonly retries: Counter<'component'>;
  readonly lockConflicts: Counter;
  readonly reconciliationDivergences: Counter;
  readonly processingDuration: Histogram;

  private readonly logger = new Logger(WageringMetrics.name);

  constructor(
    readonly registry: Registry,
    sources: GaugeSources,
  ) {
    const registers = [registry];
    this.transactions = new Counter({
      name: 'wagering_transactions_total',
      help: 'Wager transactions recorded, by resulting status (replays excluded)',
      labelNames: ['status'],
      registers,
    });
    this.duplicates = new Counter({
      name: 'wagering_duplicates_total',
      help: 'Duplicate requests or messages detected, by type',
      labelNames: ['type'],
      registers,
    });
    this.retries = new Counter({
      name: 'wagering_retries_total',
      help: 'Retries scheduled, by component',
      labelNames: ['component'],
      registers,
    });
    this.lockConflicts = new Counter({
      name: 'wagering_lock_conflicts_total',
      help: 'Transactions aborted by lock timeout or deadlock',
      registers,
    });
    this.reconciliationDivergences = new Counter({
      name: 'wagering_reconciliation_divergences_total',
      help: 'Reconciliations where the wallet balance diverged from the ledger',
      registers,
    });
    this.processingDuration = new Histogram({
      name: 'wagering_processing_duration_seconds',
      help: 'Duration of wager transaction processing',
      buckets: DURATION_BUCKETS_SECONDS,
      registers,
    });
    this.sourcedGauge('wagering_outbox_lag_seconds', 'Age of the oldest unpublished outbox event (0 when none)', () =>
      sources.outboxLagSeconds(),
    );
    this.sourcedGauge('wagering_dlq_messages', 'Approximate number of messages in the dead-letter queue', () =>
      sources.dlqMessages(),
    );
  }

  private sourcedGauge(name: string, help: string, read: () => Promise<number>): void {
    const logger = this.logger;
    new Gauge({
      name,
      help,
      registers: [this.registry],
      async collect() {
        try {
          this.set(await read());
        } catch (error) {
          logger.warn({ msg: 'metric collection failed', metric: name, error: describeError(error) });
          this.set(Number.NaN);
        }
      },
    });
  }
}
