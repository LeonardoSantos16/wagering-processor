import type { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { GaugeSources } from './wagering-metrics';

const COLLECTION_TIMEOUT_MS = 2000;

export class DatabaseAndQueueGaugeSources implements GaugeSources {
  private dlqUrl: string | undefined;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    private readonly dlqName: string,
    private readonly timeoutMs = COLLECTION_TIMEOUT_MS,
  ) {}

  async outboxLagSeconds(): Promise<number> {
    const [row] = await withTimeout(
      this.em
        .getConnection()
        .execute<{ lag: string | null }[]>(
          'select extract(epoch from now() - min(occurred_at)) as lag from outbox_message where published_at is null',
        ),
      this.timeoutMs,
    );
    return row?.lag ? Math.max(0, Number(row.lag)) : 0;
  }

  async dlqMessages(): Promise<number> {
    const { Attributes } = await withTimeout(
      this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: await this.resolveDlqUrl(),
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      ),
      this.timeoutMs,
    );
    return Number(Attributes?.ApproximateNumberOfMessages ?? '0');
  }

  private async resolveDlqUrl(): Promise<string> {
    if (!this.dlqUrl) {
      const { QueueUrl } = await withTimeout(
        this.sqs.send(new GetQueueUrlCommand({ QueueName: this.dlqName })),
        this.timeoutMs,
      );
      this.dlqUrl = QueueUrl!;
    }
    return this.dlqUrl;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
