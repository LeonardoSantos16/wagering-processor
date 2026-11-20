import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { CLOCK, type Clock } from '../../application/ports/clock';
import { UNIT_OF_WORK, type UnitOfWork } from '../../application/ports/unit-of-work';
import { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.use-case';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SqsEventPublisher } from '../messaging/sqs-event-publisher';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { PollingLoop } from './polling-loop';

@Injectable()
export class OutboxPublisherLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private loop: PollingLoop | undefined;

  constructor(
    private readonly publishOutbox: PublishOutboxUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const { publisherEnabled, batchSize, pollIntervalMs } = this.config.outbox;
    if (!publisherEnabled) {
      return;
    }
    const worker = new OutboxPublisherWorker(this.publishOutbox, { batchSize });
    this.loop = new PollingLoop(() => worker.runOnce(), {
      name: OutboxPublisherWorker.name,
      intervalMs: pollIntervalMs,
    });
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }
}

@Module({
  providers: [
    {
      provide: PublishOutboxUseCase,
      inject: [UNIT_OF_WORK, SQSClient, CLOCK, APP_CONFIG],
      useFactory: (unitOfWork: UnitOfWork, sqs: SQSClient, clock: Clock, config: AppConfig) =>
        new PublishOutboxUseCase(
          unitOfWork,
          new SqsEventPublisher(sqs, {
            queueName: config.sqs.eventsQueueName,
            timeoutMs: config.outbox.publishTimeoutMs,
          }),
          clock,
        ),
    },
    OutboxPublisherLifecycle,
  ],
})
export class OutboxPublisherModule {}
