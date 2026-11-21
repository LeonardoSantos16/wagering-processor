import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface SqsEventPublisherOptions {
  queueName: string;
  timeoutMs: number;
}

const SQS_MAX_BATCH_SIZE = 10;

export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly options: SqsEventPublisherOptions,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const queueUrl = await this.resolveQueueUrl();
    const result: PublishResult = { published: [], failures: [] };
    for (let start = 0; start < messages.length; start += SQS_MAX_BATCH_SIZE) {
      await this.sendBatch(queueUrl, messages.slice(start, start + SQS_MAX_BATCH_SIZE), result);
    }
    return result;
  }

  private async sendBatch(queueUrl: string, batch: readonly OutboxMessage[], result: PublishResult): Promise<void> {
    try {
      const { Successful, Failed } = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
          })),
        }),
        { abortSignal: AbortSignal.timeout(this.options.timeoutMs) },
      );
      for (const entry of Successful ?? []) {
        result.published.push(batch[Number(entry.Id)]!.id);
      }
      for (const entry of Failed ?? []) {
        result.failures.push({ id: batch[Number(entry.Id)]!.id, reason: `${entry.Code}: ${entry.Message ?? ''}` });
      }
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      result.failures.push(...batch.map((message) => ({ id: message.id, reason })));
    }
  }

  private async resolveQueueUrl(): Promise<string> {
    if (!this.queueUrl) {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.options.queueName }), {
        abortSignal: AbortSignal.timeout(this.options.timeoutMs),
      });
      this.queueUrl = QueueUrl!;
    }
    return this.queueUrl;
  }
}
