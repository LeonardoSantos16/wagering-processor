import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, expectViolation, rawSql } from '../../support/database';

describe('wallet table constraints', () => {
  let orm: MikroORM;

  const insertWallet = (overrides: Record<string, unknown> = {}) => {
    const row = {
      id: randomUUID(),
      player_id: `player-${randomUUID()}`,
      currency: 'BRL',
      balance: '100.00',
      version: 1,
      ...overrides,
    };
    return rawSql(
      orm,
      `insert into wallet (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, now(), now())`,
      [row.id, row.player_id, row.currency, row.balance, row.version],
    );
  };

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  test('accepts a valid wallet', async () => {
    await insertWallet();
  });

  test('allows at most one wallet per player and currency', async () => {
    const playerId = `player-${randomUUID()}`;
    await insertWallet({ player_id: playerId });

    await expectViolation(insertWallet({ player_id: playerId }), 'wallet_player_currency_unique');
  });

  test('allows the same player in another currency', async () => {
    const playerId = `player-${randomUUID()}`;
    await insertWallet({ player_id: playerId, currency: 'BRL' });

    await insertWallet({ player_id: playerId, currency: 'USD' });
  });

  test('rejects a negative balance', async () => {
    await expectViolation(insertWallet({ balance: '-0.01' }), 'wallet_balance_non_negative_check');
  });

  test('rejects a balance update that would go negative', async () => {
    const id = randomUUID();
    await insertWallet({ id, balance: '10.00' });

    await expectViolation(
      rawSql(orm, `update wallet set balance = balance - 10.01 where id = ?`, [id]),
      'wallet_balance_non_negative_check',
    );
  });

  test('rejects a version below 1', async () => {
    await expectViolation(insertWallet({ version: 0 }), 'wallet_version_positive_check');
  });

  test.each(['brl', 'BR', '12A'])('rejects the currency %p', async (currency) => {
    await expectViolation(insertWallet({ currency }), 'wallet_currency_format_check');
  });

  test('rejects a currency longer than 3 characters through the char(3) column', async () => {
    await expectViolation(insertWallet({ currency: 'BRLX' }), 'value too long');
  });

  test.each(['', 'x'.repeat(256)])('rejects a player id of length %#', async (playerId) => {
    await expectViolation(insertWallet({ player_id: playerId }), 'wallet_player_id_length_check');
  });

  test('accepts a player id of 255 characters', async () => {
    await insertWallet({ player_id: randomUUID().padEnd(255, 'x') });
  });

  test('keeps the cents exactly', async () => {
    const id = randomUUID();
    await insertWallet({ id, balance: '999999999999999999.99' });

    const rows = (await rawSql(orm, `select balance::text as balance from wallet where id = ?`, [
      id,
    ])) as { balance: string }[];
    expect(rows[0]?.balance).toBe('999999999999999999.99');
  });
});
