import { afterAll, beforeAll, describe, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, expectViolation, insertRow, rawSql } from '../../support/database';

type Row = Record<string, unknown>;

const HASH = 'a'.repeat(64);
const AT = '2026-01-01T10:00:00.000Z';

describe('wager_transaction table constraints', () => {
  let orm: MikroORM;
  let walletId: string;

  const insertWallet = async (): Promise<string> => {
    const id = randomUUID();
    await insertRow(orm, 'wallet', {
      id,
      player_id: `player-${randomUUID()}`,
      currency: 'BRL',
      balance: '100.00',
      version: 1,
      created_at: AT,
      updated_at: AT,
    });
    return id;
  };

  const processedBet = (overrides: Row = {}): Row => {
    const externalId = `tx-${randomUUID()}`;
    return {
      id: randomUUID(),
      provider_id: 'provider-a',
      external_transaction_id: externalId,
      idempotency_key: `provider-a:${externalId}`,
      round_id: 'round-1',
      game_id: 'game-1',
      wallet_id: walletId,
      player_id: 'player-1',
      kind: 'BET',
      amount: '25.00',
      currency: 'BRL',
      reference_external_transaction_id: null,
      payload_hash: HASH,
      created_at: AT,
      status: 'PROCESSED',
      reference_transaction_id: null,
      failure_code: null,
      processed_at: AT,
      resolved_at: AT,
      balance_after: '75.00',
      reference_attempts: 0,
      next_reference_attempt_at: null,
      ...overrides,
    };
  };

  const rejected = (overrides: Row = {}): Row =>
    processedBet({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
      processed_at: null,
      ...overrides,
    });

  const failed = (overrides: Row = {}): Row =>
    processedBet({
      status: 'FAILED',
      failure_code: 'PROCESSING_FAILED',
      processed_at: null,
      balance_after: null,
      ...overrides,
    });

  const pendingReference = (overrides: Row = {}): Row =>
    processedBet({
      kind: 'REFUND',
      reference_external_transaction_id: 'tx-missing',
      status: 'PENDING_REFERENCE',
      processed_at: null,
      resolved_at: null,
      balance_after: null,
      next_reference_attempt_at: AT,
      ...overrides,
    });

  const opening = (overrides: Row = {}): Row =>
    processedBet({
      kind: 'OPENING',
      provider_id: null,
      external_transaction_id: null,
      idempotency_key: null,
      round_id: null,
      game_id: null,
      payload_hash: null,
      balance_after: '25.00',
      ...overrides,
    });

  const insert = (row: Row) => insertRow(orm, 'wager_transaction', row);

  beforeAll(async () => {
    orm = await createTestOrm();
    walletId = await insertWallet();
  });

  afterAll(async () => {
    await orm.close();
  });

  describe('accepts every valid persisted shape', () => {
    test('PROCESSED', () => insert(processedBet()));
    test('REJECTED with the observed balance', () => insert(rejected()));
    test('REJECTED by CURRENCY_MISMATCH without balance', () =>
      insert(rejected({ failure_code: 'CURRENCY_MISMATCH', balance_after: null })));
    test('FAILED', () => insert(failed()));
    test('PENDING_REFERENCE', () => insert(pendingReference()));
    test('LOSS', () => insert(processedBet({ kind: 'LOSS', balance_after: '100.00' })));
    test('OPENING', async () => insert(opening({ wallet_id: await insertWallet() })));
  });

  describe('uniqueness', () => {
    test('idempotency key is unique per provider', async () => {
      const row = processedBet();
      await insert(row);

      await expectViolation(
        insert(processedBet({ idempotency_key: row.idempotency_key })),
        'wager_transaction_provider_idempotency_key_unique',
      );
    });

    test('external transaction id is unique per provider', async () => {
      const row = processedBet();
      await insert(row);

      await expectViolation(
        insert(processedBet({ external_transaction_id: row.external_transaction_id })),
        'wager_transaction_provider_external_id_unique',
      );
    });

    test('another provider may reuse the same ids', async () => {
      const row = processedBet();
      await insert(row);

      await insert(
        processedBet({
          provider_id: 'provider-b',
          external_transaction_id: row.external_transaction_id,
          idempotency_key: row.idempotency_key,
        }),
      );
    });

    test('a wallet has at most one OPENING', async () => {
      const wallet = await insertWallet();
      await insert(opening({ wallet_id: wallet }));

      await expectViolation(
        insert(opening({ wallet_id: wallet })),
        'wager_transaction_opening_per_wallet_unique',
      );
    });

    test('a transaction is reversed at most once, by REFUND or ROLLBACK', async () => {
      const bet = processedBet();
      await insert(bet);
      const reversal = (kind: string) =>
        processedBet({
          kind,
          reference_external_transaction_id: bet.external_transaction_id,
          reference_transaction_id: bet.id,
        });
      await insert(reversal('REFUND'));

      await expectViolation(insert(reversal('ROLLBACK')), 'wager_transaction_single_reversal_unique');
    });
  });

  describe('foreign keys', () => {
    test('wallet must exist', () =>
      expectViolation(
        insert(processedBet({ wallet_id: randomUUID() })),
        'wager_transaction_wallet_id_foreign',
      ));

    test('referenced transaction must exist', () =>
      expectViolation(
        insert(
          processedBet({
            kind: 'REFUND',
            reference_external_transaction_id: 'tx-100',
            reference_transaction_id: randomUUID(),
          }),
        ),
        'wager_transaction_reference_transaction_id_foreign',
      ));

    test('a wallet with transactions cannot be deleted', async () => {
      const wallet = await insertWallet();
      await insert(processedBet({ wallet_id: wallet }));

      await expectViolation(
        rawSql(orm, 'delete from wallet where id = ?', [wallet]),
        'wager_transaction_wallet_id_foreign',
      );
    });
  });

  describe('column checks', () => {
    test.each([
      [
        'PENDING is never persisted',
        { status: 'PENDING', processed_at: null, resolved_at: null, balance_after: null },
        'wager_transaction_status_check',
      ],
      ['unknown kind', { kind: 'JACKPOT' }, 'wager_transaction_kind_check'],
      ['unknown failure code', { failure_code: 'OOPS' }, 'wager_transaction_failure_code_check'],
      ['zero amount', { amount: '0.00' }, 'wager_transaction_amount_positive_check'],
      ['bad currency', { currency: 'brl' }, 'wager_transaction_currency_format_check'],
      ['negative balance', { balance_after: '-1.00' }, 'wager_transaction_balance_after_non_negative_check'],
      ['negative attempts', { reference_attempts: -1 }, 'wager_transaction_reference_attempts_non_negative_check'],
      ['bad hash', { payload_hash: 'A'.repeat(64) }, 'wager_transaction_payload_hash_format_check'],
      ['empty provider id', { provider_id: '' }, 'wager_transaction_text_length_check'],
      ['long round id', { round_id: 'x'.repeat(256) }, 'wager_transaction_text_length_check'],
      ['empty player id', { player_id: '' }, 'wager_transaction_text_length_check'],
    ])('rejects %s', (_label, overrides, constraint) =>
      expectViolation(insert(processedBet(overrides)), constraint),
    );
  });

  describe('state consistency checks', () => {
    test.each([
      [
        'REFUND without reference',
        processedBet.bind(null, { kind: 'REFUND' }),
        'wager_transaction_reference_required_check',
      ],
      [
        'PROCESSED with a failure code',
        processedBet.bind(null, { failure_code: 'INSUFFICIENT_FUNDS' }),
        'wager_transaction_failure_code_status_check',
      ],
      [
        'REJECTED without a failure code',
        rejected.bind(null, { failure_code: null }),
        'wager_transaction_failure_code_status_check',
      ],
      [
        'terminal without resolved_at',
        processedBet.bind(null, { resolved_at: null }),
        'wager_transaction_resolved_at_status_check',
      ],
      [
        'PENDING_REFERENCE with resolved_at',
        pendingReference.bind(null, { resolved_at: AT }),
        'wager_transaction_resolved_at_status_check',
      ],
      [
        'PROCESSED without processed_at',
        processedBet.bind(null, { processed_at: null }),
        'wager_transaction_processed_at_status_check',
      ],
      [
        'REJECTED with processed_at',
        rejected.bind(null, { processed_at: AT }),
        'wager_transaction_processed_at_status_check',
      ],
      [
        'PENDING_REFERENCE without next attempt',
        pendingReference.bind(null, { next_reference_attempt_at: null }),
        'wager_transaction_next_reference_attempt_status_check',
      ],
      [
        'PROCESSED with next attempt',
        processedBet.bind(null, { next_reference_attempt_at: AT }),
        'wager_transaction_next_reference_attempt_status_check',
      ],
      [
        'provider transaction without payload hash',
        processedBet.bind(null, { payload_hash: null }),
        'wager_transaction_payload_hash_kind_check',
      ],
      [
        'OPENING with payload hash',
        opening.bind(null, { payload_hash: HASH }),
        'wager_transaction_payload_hash_kind_check',
      ],
      [
        'provider transaction without provider id',
        processedBet.bind(null, { provider_id: null }),
        'wager_transaction_provider_fields_kind_check',
      ],
      [
        'OPENING with a round id',
        opening.bind(null, { round_id: 'round-1' }),
        'wager_transaction_provider_fields_kind_check',
      ],
      [
        'PROCESSED without balance',
        processedBet.bind(null, { balance_after: null }),
        'wager_transaction_balance_after_status_check',
      ],
      [
        'REJECTED without balance',
        rejected.bind(null, { balance_after: null }),
        'wager_transaction_balance_after_status_check',
      ],
      [
        'CURRENCY_MISMATCH with balance',
        rejected.bind(null, { failure_code: 'CURRENCY_MISMATCH' }),
        'wager_transaction_balance_after_status_check',
      ],
      [
        'FAILED with balance',
        failed.bind(null, { balance_after: '1.00' }),
        'wager_transaction_balance_after_status_check',
      ],
    ] as const)('rejects %s', (_label, build, constraint) =>
      expectViolation(insert(build()), constraint),
    );

    test('rejects a reference id on a non-PROCESSED transaction', async () => {
      const bet = processedBet();
      await insert(bet);

      await expectViolation(
        insert(
          failed({
            kind: 'REFUND',
            reference_external_transaction_id: bet.external_transaction_id,
            reference_transaction_id: bet.id,
          }),
        ),
        'wager_transaction_reference_transaction_status_check',
      );
    });
  });

  describe('terminal rows are immutable', () => {
    test.each([
      ['PROCESSED', processedBet],
      ['REJECTED', rejected],
      ['FAILED', failed],
    ] as const)('blocks UPDATE of a %s row', async (_status, build) => {
      const row = build();
      await insert(row);

      await expectViolation(
        rawSql(orm, `update wager_transaction set reference_attempts = 1 where id = ?`, [row.id]),
        'wager_transaction is immutable once terminal',
      );
    });

    test('allows resolving a PENDING_REFERENCE row', async () => {
      const row = pendingReference();
      await insert(row);

      await rawSql(
        orm,
        `update wager_transaction
            set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', resolved_at = now(),
                balance_after = '100.00', next_reference_attempt_at = null
          where id = ?`,
        [row.id],
      );
    });

    test('blocks DELETE of any row', async () => {
      const row = pendingReference();
      await insert(row);

      await expectViolation(
        rawSql(orm, `delete from wager_transaction where id = ?`, [row.id]),
        'wager_transaction rows cannot be deleted',
      );
    });
  });
});
