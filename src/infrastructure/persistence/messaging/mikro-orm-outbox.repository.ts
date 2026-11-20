import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../../application/ports/outbox.repository';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { OutboxMessageRecord } from './outbox-message.entity';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<OutboxMessage | null> {
    const record = await this.em.findOne(OutboxMessageRecord, { id });
    return record ? toDomain(record) : null;
  }

  async findDueForUpdate(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      { orderBy: { occurredAt: 'asc', id: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map(toDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    const data = toRecord(message);
    const managed = this.em.getUnitOfWork().getById(OutboxMessageRecord, message.id);
    if (managed) {
      this.em.assign(managed, data);
    } else {
      this.em.create(OutboxMessageRecord, data);
    }
  }
}

function toDomain(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
    publishedAt: record.publishedAt ?? undefined,
  });
}

function toRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  };
}
