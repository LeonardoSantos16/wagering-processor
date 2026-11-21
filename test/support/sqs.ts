import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/infrastructure/config/app-config';

export function testSqsClient(): SQSClient {
  const { aws } = loadConfig();
  return new SQSClient({
    region: aws.region,
    endpoint: aws.endpoint,
    credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
  });
}

export interface TestQueues {
  queueName: string;
  dlqName: string;
  queueUrl: string;
  dlqUrl: string;
  remove(): Promise<void>;
}

export async function createTestQueues(
  sqs: SQSClient,
  { maxReceiveCount = 2, visibilityTimeoutSeconds = 5 } = {},
): Promise<TestQueues> {
  const name = `test-${randomUUID()}`;
  const fifo = { FifoQueue: 'true' };
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${name}-dlq.fifo`, Attributes: fifo }));
  const dlqArn = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${name}.fifo`,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn.Attributes!.QueueArn,
          maxReceiveCount,
        }),
      },
    }),
  );
  const queueUrl = queue.QueueUrl!;
  const dlqUrl = dlq.QueueUrl!;
  return {
    queueName: `${name}.fifo`,
    dlqName: `${name}-dlq.fifo`,
    queueUrl,
    dlqUrl,
    remove: async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

export interface WagerMessageData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wagerMessage(data: WagerMessageData, messageId = `msg-${randomUUID()}`) {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
}

export async function sendMessage(
  sqs: SQSClient,
  queueUrl: string,
  body: unknown,
  groupId: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

export async function messagesInQueue(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes!.ApproximateNumberOfMessages) + Number(Attributes!.ApproximateNumberOfMessagesNotVisible);
}

export interface ReceivedMessage {
  body: string;
  failureReason: string | undefined;
}

export async function receiveMessages(sqs: SQSClient, queueUrl: string): Promise<ReceivedMessage[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
    }),
  );
  return (Messages ?? []).map((message) => ({
    body: message.Body!,
    failureReason: message.MessageAttributes?.failureReason?.StringValue,
  }));
}

export interface PublishedEvent {
  body: Record<string, unknown>;
  groupId: string | undefined;
  deduplicationId: string | undefined;
  eventType: string | undefined;
}

export async function drainEvents(sqs: SQSClient, queueUrl: string): Promise<PublishedEvent[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
    }),
  );
  const events: PublishedEvent[] = [];
  for (const message of Messages ?? []) {
    events.push({
      body: JSON.parse(message.Body!) as Record<string, unknown>,
      groupId: message.Attributes?.MessageGroupId,
      deduplicationId: message.Attributes?.MessageDeduplicationId,
      eventType: message.MessageAttributes?.eventType?.StringValue,
    });
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }
  return events;
}
