import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishFailure {
  id: string;
  reason: string;
}

export interface PublishResult {
  published: string[];
  failures: PublishFailure[];
}

export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
