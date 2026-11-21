import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

export const InboxMessageRecord = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_message',
  checks: [
    {
      name: 'inbox_message_payload_hash_format_check',
      expression: "payload_hash ~ '^[0-9a-f]{64}$'",
    },
    { name: 'inbox_message_consumer_name_not_empty_check', expression: "consumer_name <> ''" },
    { name: 'inbox_message_message_id_not_empty_check', expression: "message_id <> ''" },
  ],
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.string().columnType('char(64)'),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export type InboxMessageRecord = InferEntity<typeof InboxMessageRecord>;
