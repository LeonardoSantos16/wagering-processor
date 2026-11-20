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
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
