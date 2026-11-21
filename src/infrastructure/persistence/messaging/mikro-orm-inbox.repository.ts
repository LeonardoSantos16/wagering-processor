import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../../application/ports/inbox.repository';
import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { InboxMessageRecord } from './inbox-message.entity';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId });
    return record ? toDomain(record) : null;
  }

  async save(message: InboxMessage): Promise<void> {
    const data = toRecord(message);
    const managed = this.em
      .getUnitOfWork()
      .getById(InboxMessageRecord, [message.consumerName, message.messageId]);
    if (managed) {
      this.em.assign(managed, data);
    } else {
      this.em.create(InboxMessageRecord, data);
    }
  }
}

function toDomain(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt ?? undefined,
  });
}

function toRecord(message: InboxMessage): InboxMessageRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}
