import type { InboxMessage } from '../../domain/messaging/inbox-message';

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  save(message: InboxMessage): Promise<void>;
}

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
