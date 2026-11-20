import { afterAll, beforeAll, describe, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, expectViolation, insertRow, rawSql } from '../../support/database';

type Row = Record<string, unknown>;

const AT = '2026-01-01T10:00:00.000Z';

describe('wallet_ledger_entry table constraints', () => {
  let orm: MikroORM;
  let walletId: string;

  const insertWallet = async (currency = 'BRL'): Promise<string> => {
    const id = randomUUID();
    await insertRow(orm, 'wallet', {
      id,
      player_id: `player-${randomUUID()}`,
      currency,
      balance: '100.00',
      version: 1,
      created_at: AT,
      updated_at: AT,
    });
    return id;
  };

  const insertTransaction = async (wallet = walletId, currency = 'BRL'): Promise<string> => {
    const id = randomUUID();
    const externalId = `tx-${randomUUID()}`;
    await insertRow(orm, 'wager_transaction', {
      id,
      provider_id: 'provider-a',
      external_transaction_id: externalId,
      idempotency_key: `provider-a:${externalId}`,
      round_id: 'round-1',
      game_id: 'game-1',
      wallet_id: wallet,
      player_id: 'player-1',
      kind: 'BET',
      amount: '25.00',
      currency,
      payload_hash: 'a'.repeat(64),
      created_at: AT,
      status: 'PROCESSED',
      processed_at: AT,
      resolved_at: AT,
      balance_after: '75.00',
      reference_attempts: 0,
    });
    return id;
  };

  /** A valid DEBIT of 25.00 from 100.00; overrides replace columns. */
  const debit = async (overrides: Row = {}): Promise<Row> => ({
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: await insertTransaction(),
    direction: 'DEBIT',
    amount: '25.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '75.00',
    created_at: AT,
    ...overrides,
  });

  const insert = (row: Row) => insertRow(orm, 'wallet_ledger_entry', row);

  beforeAll(async () => {
    orm = await createTestOrm();
    walletId = await insertWallet();
  });

  afterAll(async () => {
    await orm.close();
  });

  describe('accepts balanced entries', () => {
    test('DEBIT', async () => insert(await debit()));
    test('CREDIT', async () =>
      insert(await debit({ direction: 'CREDIT', balance_after: '125.00' })));
    test('DEBIT down to zero', async () =>
      insert(await debit({ balance_before: '25.00', balance_after: '0.00' })));
  });

  test('allows at most one entry per wallet and transaction', async () => {
    const row = await debit();
    await insert(row);

    await expectViolation(
      insert({ ...row, id: randomUUID() }),
      'wallet_ledger_entry_wallet_transaction_unique',
    );
  });

  describe('foreign keys', () => {
    test('transaction must exist', async () =>
      expectViolation(
        insert(await debit({ transaction_id: randomUUID() })),
        'wallet_ledger_entry_transaction_id_foreign',
      ));

    test('wallet must exist', async () =>
      expectViolation(
        insert(await debit({ wallet_id: randomUUID() })),
        'wallet_ledger_entry_wallet_currency_foreign',
      ));

    test('currency must be the wallet currency', async () => {
      const usdWallet = await insertWallet('USD');
      const transactionId = await insertTransaction(usdWallet, 'BRL');

      await expectViolation(
        insert(await debit({ wallet_id: usdWallet, transaction_id: transactionId })),
        'wallet_ledger_entry_wallet_currency_foreign',
      );
    });

    test('a wallet with entries cannot change its currency', async () => {
      const wallet = await insertWallet();
      await insert(await debit({ wallet_id: wallet, transaction_id: await insertTransaction(wallet) }));

      await expectViolation(
        rawSql(orm, `update wallet set currency = 'USD' where id = ?`, [wallet]),
        'wallet_ledger_entry_wallet_currency_foreign',
      );
    });
  });

  describe('checks', () => {
    test.each([
      ['zero amount', { amount: '0.00', balance_after: '100.00' }, 'wallet_ledger_entry_amount_positive_check'],
      ['negative balance before', { direction: 'CREDIT', balance_before: '-1.00', balance_after: '24.00' }, 'wallet_ledger_entry_balance_before_non_negative_check'],
      ['negative balance after', { balance_before: '10.00', balance_after: '-15.00' }, 'wallet_ledger_entry_balance_after_non_negative_check'],
      // An unknown direction can never balance, so the balanced check (evaluated first, by name) rejects it.
      ['unknown direction', { direction: 'SIDEWAYS' }, 'wallet_ledger_entry_balanced_check'],
      ['unbalanced DEBIT', { balance_after: '76.00' }, 'wallet_ledger_entry_balanced_check'],
      ['DEBIT computed as CREDIT', { balance_after: '125.00' }, 'wallet_ledger_entry_balanced_check'],
      ['unbalanced CREDIT', { direction: 'CREDIT', balance_after: '124.99' }, 'wallet_ledger_entry_balanced_check'],
    ])('rejects %s', async (_label, overrides, constraint) =>
      expectViolation(insert(await debit(overrides)), constraint),
    );
  });

  describe('immutability', () => {
    test('blocks UPDATE', async () => {
      const row = await debit();
      await insert(row);

      await expectViolation(
        rawSql(orm, `update wallet_ledger_entry set created_at = now() where id = ?`, [row.id]),
        'wallet_ledger_entry is append-only',
      );
    });

    test('blocks DELETE', async () => {
      const row = await debit();
      await insert(row);

      await expectViolation(
        rawSql(orm, `delete from wallet_ledger_entry where id = ?`, [row.id]),
        'wallet_ledger_entry is append-only',
      );
    });

    test('blocks TRUNCATE', () =>
      expectViolation(
        rawSql(orm, `truncate wallet_ledger_entry`),
        'wallet_ledger_entry is append-only',
      ));
  });
});
