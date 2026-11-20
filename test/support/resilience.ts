import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppEnv } from './app-process';
import { rawSql, type TemporaryDatabase } from './database';
import type { TestQueues } from './sqs';

export interface ResilienceInfra {
  database: TemporaryDatabase;
  queues: TestQueues;
  events: TestQueues;
}

export function appEnvFor({ database, queues, events }: ResilienceInfra): AppEnv {
  return {
    DB_NAME: database.name,
    SQS_WAGER_QUEUE_NAME: queues.queueName,
    SQS_WAGER_DLQ_NAME: queues.dlqName,
    SQS_EVENTS_QUEUE_NAME: events.queueName,
    SQS_CONSUMER_ENABLED: 'false',
    OUTBOX_PUBLISHER_ENABLED: 'false',
    PENDING_REFERENCE_WORKER_ENABLED: 'false',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
  };
}

export async function countRows(orm: MikroORM, sql: string, params: unknown[] = []): Promise<number> {
  const rows = (await rawSql(orm, sql, params)) as { count: string }[];
  return Number(rows[0]!.count);
}

export function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
