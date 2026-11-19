import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { Public } from '../auth/public.decorator';

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [database, sqs] = await Promise.all([this.checkDatabase(), this.checkSqs()]);
    const checks = { database, sqs };

    if (database !== 'up' || sqs !== 'up') {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  }

  private async checkDatabase(): Promise<CheckStatus> {
    try {
      await withTimeout(this.em.getConnection().execute('select 1'), CHECK_TIMEOUT_MS);
      return 'up';
    } catch (error) {
      this.logger.warn({ check: 'database', reason: describeError(error) }, 'readiness check failed');
      return 'down';
    }
  }

  private async checkSqs(): Promise<CheckStatus> {
    try {
      await withTimeout(
        this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueueName })),
        CHECK_TIMEOUT_MS,
      );
      return 'up';
    } catch (error) {
      this.logger.warn({ check: 'sqs', reason: describeError(error) }, 'readiness check failed');
      return 'down';
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}
