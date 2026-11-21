export interface AppConfig {
  port: number;
  logLevel: string;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
    lockTimeoutMs: number;
  };
  aws: {
    region: string;
    endpoint: string | undefined;
    accessKeyId: string;
    secretAccessKey: string;
  };
  sqs: {
    wagerQueueName: string;
    deadLetterQueueName: string;
    eventsQueueName: string;
    consumerEnabled: boolean;
  };
  outbox: {
    publisherEnabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    publishTimeoutMs: number;
  };
  pendingReference: {
    ttlMs: number;
    workerEnabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
  };
}

function readString(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readPort(name: string, fallback: string): number {
  const raw = readString(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid port in ${name}: ${raw}`);
  }
  return value;
}

function readPositiveInteger(name: string, fallback: string): number {
  const raw = readString(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid positive integer in ${name}: ${raw}`);
  }
  return value;
}

function readBoolean(name: string, fallback: string): boolean {
  const raw = readString(name, fallback);
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`Invalid boolean in ${name}: ${raw}`);
  }
  return raw === 'true';
}

export function loadConfig(): AppConfig {
  const awsEndpoint = process.env.AWS_ENDPOINT ?? 'http://localhost:4566';
  return {
    port: readPort('PORT', '3000'),
    logLevel: readString('LOG_LEVEL', 'info'),
    db: {
      host: readString('DB_HOST', 'localhost'),
      port: readPort('DB_PORT', '5432'),
      user: readString('DB_USER', 'wagering'),
      password: readString('DB_PASSWORD', 'wagering'),
      name: readString('DB_NAME', 'wagering'),
      lockTimeoutMs: readPositiveInteger('WALLET_LOCK_TIMEOUT_MS', '2000'),
    },
    aws: {
      region: readString('AWS_REGION', 'us-east-1'),
      // Defaults to LocalStack, like the other local-development defaults.
      // Set AWS_ENDPOINT to an empty string to use the real AWS endpoints.
      endpoint: awsEndpoint === '' ? undefined : awsEndpoint,
      accessKeyId: readString('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: readString('AWS_SECRET_ACCESS_KEY', 'test'),
    },
    sqs: {
      wagerQueueName: readString('SQS_WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
      deadLetterQueueName: readString('SQS_WAGER_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      eventsQueueName: readString('SQS_EVENTS_QUEUE_NAME', 'wagering-events.fifo'),
      consumerEnabled: readBoolean('SQS_CONSUMER_ENABLED', 'true'),
    },
    outbox: {
      publisherEnabled: readBoolean('OUTBOX_PUBLISHER_ENABLED', 'true'),
      pollIntervalMs: readPositiveInteger('OUTBOX_POLL_INTERVAL_MS', '1000'),
      batchSize: readPositiveInteger('OUTBOX_BATCH_SIZE', '10'),
      publishTimeoutMs: readPositiveInteger('OUTBOX_PUBLISH_TIMEOUT_MS', '5000'),
    },
    pendingReference: {
      ttlMs: readPositiveInteger('PENDING_REFERENCE_TTL_MS', '3600000'),
      workerEnabled: readBoolean('PENDING_REFERENCE_WORKER_ENABLED', 'true'),
      pollIntervalMs: readPositiveInteger('PENDING_REFERENCE_POLL_INTERVAL_MS', '1000'),
      batchSize: readPositiveInteger('PENDING_REFERENCE_BATCH_SIZE', '10'),
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
