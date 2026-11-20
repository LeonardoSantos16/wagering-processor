import { afterAll, beforeAll, describe, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, expectViolation, insertRow } from '../../support/database';

type Row = Record<string, unknown>;

const AT = '2026-01-01T10:00:00.000Z';

describe('messaging tables constraints', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  describe('outbox_message', () => {
    const message = (overrides: Row = {}): Row => ({
      id: randomUUID(),
      aggregate_id: randomUUID(),
      event_type: 'WagerTransactionProcessed',
      payload: JSON.stringify({ eventId: 'e-1', data: { amount: '25.00' } }),
      occurred_at: AT,
      attempts: 0,
      next_attempt_at: null,
      published_at: null,
      ...overrides,
    });
    const insert = (row: Row) => insertRow(orm, 'outbox_message', row);

    test('accepts a pending message', () => insert(message()));
    test('accepts a published message', () => insert(message({ attempts: 2, published_at: AT })));

    test('id is unique (one row per event)', async () => {
      const row = message();
      await insert(row);

      await expectViolation(insert(message({ id: row.id })), 'outbox_message_pkey');
    });

    test('rejects negative attempts', () =>
      expectViolation(insert(message({ attempts: -1 })), 'outbox_message_attempts_non_negative_check'));

    test('rejects an empty event type', () =>
      expectViolation(insert(message({ event_type: '' })), 'outbox_message_event_type_not_empty_check'));

    test('rejects a published message with a scheduled retry', () =>
      expectViolation(
        insert(message({ published_at: AT, next_attempt_at: AT })),
        'outbox_message_published_without_next_attempt_check',
      ));

    test('rejects a payload that is not JSON', () =>
      expectViolation(insert(message({ payload: 'not json' })), 'invalid input syntax for type json'));
  });

  describe('inbox_message', () => {
    const message = (overrides: Row = {}): Row => ({
      consumer_name: 'wager-transactions',
      message_id: randomUUID(),
      payload_hash: 'b'.repeat(64),
      received_at: AT,
      processed_at: null,
      ...overrides,
    });
    const insert = (row: Row) => insertRow(orm, 'inbox_message', row);

    test('accepts a received message', () => insert(message()));

    test('a message is recorded once per consumer', async () => {
      const row = message();
      await insert(row);

      await expectViolation(insert(message({ message_id: row.message_id })), 'inbox_message_pkey');
    });

    test('another consumer may record the same message', async () => {
      const row = message();
      await insert(row);

      await insert(message({ message_id: row.message_id, consumer_name: 'reconciliation' }));
    });

    test('rejects an empty consumer name', () =>
      expectViolation(insert(message({ consumer_name: '' })), 'inbox_message_consumer_name_not_empty_check'));

    test('rejects an empty message id', () =>
      expectViolation(insert(message({ message_id: '' })), 'inbox_message_message_id_not_empty_check'));

    test.each(['B'.repeat(64), 'b'.repeat(63), 'g'.repeat(64)])('rejects the hash %#', (hash) =>
      expectViolation(insert(message({ payload_hash: hash })), 'inbox_message_payload_hash_format_check'),
    );
  });
});
