import { defineEntity, type InferEntity } from '@mikro-orm/core';
import { FailureCode } from '../../../domain/errors/failure-code';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import { WalletRecord } from '../wallet/wallet.entity';

const inList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

const PERSISTED_STATUSES = Object.values(WagerTransactionStatus).filter(
  (status) => status !== WagerTransactionStatus.Pending,
);
const PROVIDER_COLUMNS = [
  'provider_id',
  'external_transaction_id',
  'idempotency_key',
  'round_id',
  'game_id',
] as const;
const TEXT_COLUMNS = [...PROVIDER_COLUMNS, 'player_id', 'reference_external_transaction_id'];

const lengthBetween1And255 = (column: string) =>
  `(${column} is null or (char_length(${column}) >= 1 and char_length(${column}) <= 255))`;

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transaction',
  uniques: [
    {
      name: 'wager_transaction_provider_idempotency_key_unique',
      properties: ['providerId', 'idempotencyKey'],
    },
    {
      name: 'wager_transaction_provider_external_id_unique',
      properties: ['providerId', 'externalTransactionId'],
    },
    {
      name: 'wager_transaction_opening_per_wallet_unique',
      properties: ['walletId'],
      where: { kind: WagerTransactionKind.Opening },
    },
    {
      name: 'wager_transaction_single_reversal_unique',
      properties: ['referenceTransactionId'],
      where: {
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
        status: WagerTransactionStatus.Processed,
      },
    },
  ],
  indexes: [
    { name: 'wager_transaction_wallet_id_index', properties: ['walletId'] },
    {
      name: 'wager_transaction_pending_reference_index',
      properties: ['nextReferenceAttemptAt'],
      where: { status: WagerTransactionStatus.PendingReference },
    },
  ],
  checks: [
    {
      name: 'wager_transaction_status_check',
      expression: `status in (${inList(PERSISTED_STATUSES)})`,
    },
    {
      name: 'wager_transaction_kind_check',
      expression: `kind in (${inList(Object.values(WagerTransactionKind))})`,
    },
    {
      name: 'wager_transaction_failure_code_check',
      expression: `failure_code in (${inList(Object.values(FailureCode))})`,
    },
    { name: 'wager_transaction_amount_positive_check', expression: 'amount > 0' },
    {
      name: 'wager_transaction_currency_format_check',
      expression: "currency ~ '^[A-Z]{3}$'",
    },
    {
      name: 'wager_transaction_balance_after_non_negative_check',
      expression: 'balance_after >= 0',
    },
    {
      name: 'wager_transaction_reference_attempts_non_negative_check',
      expression: 'reference_attempts >= 0',
    },
    {
      name: 'wager_transaction_payload_hash_format_check',
      expression: "payload_hash ~ '^[0-9a-f]{64}$'",
    },
    {
      name: 'wager_transaction_text_length_check',
      expression: TEXT_COLUMNS.map(lengthBetween1And255).join(' and '),
    },
    {
      name: 'wager_transaction_reference_required_check',
      expression: `kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null`,
    },
    {
      name: 'wager_transaction_failure_code_status_check',
      expression: `(failure_code is not null) = (status in ('REJECTED', 'FAILED'))`,
    },
    {
      name: 'wager_transaction_resolved_at_status_check',
      expression: `(resolved_at is not null) = (status in ('PROCESSED', 'REJECTED', 'FAILED'))`,
    },
    {
      name: 'wager_transaction_processed_at_status_check',
      expression: `(processed_at is not null) = (status = 'PROCESSED')`,
    },
    {
      name: 'wager_transaction_reference_transaction_status_check',
      expression: `reference_transaction_id is null or status = 'PROCESSED'`,
    },
    {
      name: 'wager_transaction_next_reference_attempt_status_check',
      expression: `(next_reference_attempt_at is not null) = (status = 'PENDING_REFERENCE')`,
    },
    {
      name: 'wager_transaction_payload_hash_kind_check',
      expression: `(payload_hash is not null) = (kind <> 'OPENING')`,
    },
    {
      name: 'wager_transaction_provider_fields_kind_check',
      expression:
        `(kind = 'OPENING' and ${PROVIDER_COLUMNS.map((c) => `${c} is null`).join(' and ')}` +
        ` and reference_external_transaction_id is null)` +
        ` or (kind <> 'OPENING' and ${PROVIDER_COLUMNS.map((c) => `${c} is not null`).join(' and ')})`,
    },
    {
      name: 'wager_transaction_balance_after_status_check',
      expression:
        `(balance_after is not null) = (status = 'PROCESSED'` +
        ` or (status = 'REJECTED' and failure_code <> 'CURRENCY_MISMATCH'))`,
    },
  ],
  triggers: [
    {
      name: 'wager_transaction_terminal_immutable',
      timing: 'before',
      events: ['update', 'delete'],
      forEach: 'row',
      body:
        `IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'wager_transaction rows cannot be deleted'; END IF;` +
        ` IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN` +
        ` RAISE EXCEPTION 'wager_transaction is immutable once terminal'; END IF;` +
        ` RETURN NEW;`,
    },
  ],
  properties: (properties) => ({
    id: properties.uuid().primary(),
    providerId: properties.text().nullable(),
    externalTransactionId: properties.text().nullable(),
    idempotencyKey: properties.text().nullable(),
    roundId: properties.text().nullable(),
    gameId: properties.text().nullable(),
    walletId: properties
      .manyToOne(WalletRecord)
      .mapToPk()
      .fieldName('wallet_id')
      .deleteRule('restrict')
      .updateRule('restrict'),
    playerId: properties.text(),
    kind: properties.text(),
    amount: properties.decimal('string').precision(20).scale(2),
    currency: properties.string().columnType('char(3)'),
    referenceExternalTransactionId: properties.text().nullable(),
    payloadHash: properties.string().columnType('char(64)').nullable(),
    createdAt: properties.datetime(),
    status: properties.text(),
    referenceTransactionId: properties.uuid().nullable(),
    failureCode: properties.text().nullable(),
    processedAt: properties.datetime().nullable(),
    resolvedAt: properties.datetime().nullable(),
    balanceAfter: properties.decimal('string').precision(20).scale(2).nullable(),
    referenceAttempts: properties.integer(),
    nextReferenceAttemptAt: properties.datetime().nullable(),
  }),
});

export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;

WagerTransactionRecord.addManyToOne('referenceTransactionId', 'WagerTransactionRecord', {
  mapToPk: true,
  nullable: true,
  fieldName: 'reference_transaction_id',
  deleteRule: 'restrict',
  updateRule: 'restrict',
});
