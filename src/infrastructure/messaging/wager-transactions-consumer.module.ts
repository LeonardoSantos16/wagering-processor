import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { InstrumentedProcessWagerTransaction } from '../metrics/instrumented-process-wager-transaction';
import { WageringMetrics } from '../metrics/wagering-metrics';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { WageringModule } from '../http/wagering/wagering.module';
import { WagerTransactionsConsumer } from './wager-transactions.consumer';

export const WAGER_TRANSACTIONS_CONSUMER_NAME = 'wager-transactions-consumer';

@Injectable()
export class WagerTransactionsConsumerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer: WagerTransactionsConsumer | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processTransaction: InstrumentedProcessWagerTransaction,
    private readonly metrics: WageringMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.sqs.consumerEnabled) {
      return;
    }
    const [queueUrl, dlqUrl] = await Promise.all([
      this.queueUrl(this.config.sqs.wagerQueueName),
      this.queueUrl(this.config.sqs.deadLetterQueueName),
    ]);
    this.consumer = new WagerTransactionsConsumer(this.sqs, this.processTransaction, {
      queueUrl,
      dlqUrl,
      consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
    }, this.metrics);
    this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }

  private async queueUrl(name: string): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    return QueueUrl!;
  }
}

@Module({
  imports: [WageringModule],
  providers: [WagerTransactionsConsumerLifecycle],
})
export class WagerTransactionsConsumerModule {}
