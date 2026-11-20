import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

export const OutboxMessageRecord = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_message',
  indexes: [
    {
      name: 'outbox_message_pending_index',
      properties: ['nextAttemptAt'],
      where: { publishedAt: null },
    },
  ],
  checks: [
    { name: 'outbox_message_attempts_non_negative_check', expression: 'attempts >= 0' },
    { name: 'outbox_message_event_type_not_empty_check', expression: "event_type <> ''" },
  ],
  properties: {
    // The id is the event id: one row per event, and the dedup key along the whole chain.
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>().columnType('jsonb'),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
  },
});

export type OutboxMessageRecord = InferEntity<typeof OutboxMessageRecord>;
