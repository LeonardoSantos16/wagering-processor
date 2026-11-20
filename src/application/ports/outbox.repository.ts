import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface OutboxRepository {
  findById(id: string): Promise<OutboxMessage | null>;
  save(message: OutboxMessage): Promise<void>;
}

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
