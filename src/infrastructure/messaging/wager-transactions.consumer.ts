import { Logger } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { InboxMessageConflictError } from '../../application/errors/wager-transaction.errors';
import type { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { DomainError } from '../../domain/errors/domain-error';
import { FailureCode } from '../../domain/errors/failure-code';
import { computeBackoffDelay } from '../../domain/shared/backoff';
import type { WageringMetrics } from '../metrics/wagering-metrics';
import { pause } from '../system/pause';
import { InvalidMessageError, parseWagerTransactionMessage } from './wager-transaction-message';

export interface WagerTransactionsConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  waitTimeSeconds?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  shutdownTimeoutMs?: number;
}

const DEFAULTS = {
  waitTimeSeconds: 20,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  shutdownTimeoutMs: 10_000,
};

const RECEIVE_FAILURE_PAUSE_MS = 1_000;

export class WagerTransactionsConsumer {
  private readonly logger = new Logger(WagerTransactionsConsumer.name);
  private readonly options: Required<WagerTransactionsConsumerOptions>;
  private stopping: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processTransaction: Pick<ProcessWagerTransactionUseCase, 'execute'>,
    options: WagerTransactionsConsumerOptions,
    private readonly metrics?: WageringMetrics,
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  start(): void {
    if (this.loop) {
      return;
    }
    const stopping = new AbortController();
    this.stopping = stopping;
    this.loop = this.run(stopping.signal);
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    if (!loop) {
      return;
    }
    this.stopping!.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.shutdownTimeoutMs);
    });
    const outcome = await Promise.race([loop.then(() => 'done' as const), timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.logger.warn({ msg: 'consumer stopped before the in-flight message finished' });
    }
    this.loop = undefined;
    this.stopping = undefined;
  }

  private async run(stopping: AbortSignal): Promise<void> {
    while (!stopping.aborted) {
      const message = await this.receive(stopping);
      if (!message) {
        continue;
      }
      if (stopping.aborted) {
        await this.changeVisibility(message, 0);
        return;
      }
      await this.handle(message);
    }
  }

  private async receive(stopping: AbortSignal): Promise<Message | undefined> {
    try {
      const { Messages } = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.options.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: stopping },
      );
      return Messages?.[0];
    } catch (error) {
      if (!stopping.aborted) {
        this.logger.error({ msg: 'failed to receive messages', error: describe(error) });
        await pause(RECEIVE_FAILURE_PAUSE_MS, stopping);
      }
      return undefined;
    }
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const context = { sqsMessageId: message.MessageId, receiveCount };
    try {
      const command = parseWagerTransactionMessage(message.Body, this.options.consumerName);
      await this.processTransaction.execute(command);
      await this.delete(message);
      this.logger.log({ msg: 'message processed', ...context, messageId: command.inbox!.messageId });
    } catch (error) {
      if (isDeadLetter(error)) {
        await this.deadLetter(message, error, context);
      } else {
        await this.retryLater(message, receiveCount, error, context);
      }
    }
  }

  private async deadLetter(message: Message, error: unknown, context: object): Promise<void> {
    const reason = describe(error);
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.options.dlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: { failureReason: { DataType: 'String', StringValue: reason.slice(0, 1024) } },
        }),
      );
      await this.delete(message);
      this.logger.warn({ msg: 'message sent to the dead-letter queue', ...context, reason });
    } catch (sendError) {
      this.logger.error({ msg: 'failed to dead-letter message', ...context, reason, error: describe(sendError) });
    }
  }

  private async retryLater(message: Message, receiveCount: number, error: unknown, context: object): Promise<void> {
    const delayMs = computeBackoffDelay(receiveCount, this.options.backoffBaseMs, this.options.backoffMaxMs);
    const delaySeconds = Math.ceil(delayMs / 1000);
    this.metrics?.retries.inc({ component: 'sqs_consumer' });
    this.logger.warn({ msg: 'message processing failed, will retry', ...context, delaySeconds, error: describe(error) });
    await this.changeVisibility(message, delaySeconds);
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.error({ msg: 'failed to change message visibility', sqsMessageId: message.MessageId, error: describe(error) });
    }
  }

  private async delete(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }
}

function isDeadLetter(error: unknown): boolean {
  return (
    error instanceof InvalidMessageError ||
    error instanceof InboxMessageConflictError ||
    (error instanceof DomainError && error.code !== FailureCode.TemporarilyUnavailable)
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
