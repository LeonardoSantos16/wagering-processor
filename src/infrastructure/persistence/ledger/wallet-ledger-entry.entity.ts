import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { LedgerDirection } from '../../../domain/ledger/wallet-ledger-entry';
import { WagerTransactionRecord } from '../wager-transaction/wager-transaction.entity';

const APPEND_ONLY = `RAISE EXCEPTION 'wallet_ledger_entry is append-only';`;

export const WalletLedgerEntryRecord = defineEntity({
  name: 'WalletLedgerEntryRecord',
  tableName: 'wallet_ledger_entry',
  uniques: [
    {
      name: 'wallet_ledger_entry_wallet_transaction_unique',
      properties: ['walletId', 'transactionId'],
    },
  ],
  indexes: [
    { name: 'wallet_ledger_entry_wallet_created_at_index', properties: ['walletId', 'createdAt'] },
  ],
  checks: [
    { name: 'wallet_ledger_entry_amount_positive_check', expression: 'amount > 0' },
    {
      name: 'wallet_ledger_entry_balance_before_non_negative_check',
      expression: 'balance_before >= 0',
    },
    {
      name: 'wallet_ledger_entry_balance_after_non_negative_check',
      expression: 'balance_after >= 0',
    },
    {
      name: 'wallet_ledger_entry_direction_check',
      expression: `direction in (${Object.values(LedgerDirection)
        .map((d) => `'${d}'`)
        .join(', ')})`,
    },
    {
      name: 'wallet_ledger_entry_balanced_check',
      expression:
        `(direction = 'CREDIT' and balance_after = balance_before + amount)` +
        ` or (direction = 'DEBIT' and balance_after = balance_before - amount)`,
    },
  ],
  triggers: [
    {
      name: 'wallet_ledger_entry_append_only_row',
      timing: 'before',
      events: ['update', 'delete'],
      forEach: 'row',
      body: `${APPEND_ONLY} RETURN NULL;`,
    },
    {
      name: 'wallet_ledger_entry_append_only_truncate',
      timing: 'before',
      events: ['truncate'],
      forEach: 'statement',
      body: `${APPEND_ONLY} RETURN NULL;`,
    },
  ],
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p
      .manyToOne(WagerTransactionRecord)
      .mapToPk()
      .fieldName('transaction_id')
      .deleteRule('restrict')
      .updateRule('restrict'),
    direction: p.text(),
    amount: p.decimal('string').precision(20).scale(2),
    currency: p.string().columnType('char(3)'),
    balanceBefore: p.decimal('string').precision(20).scale(2),
    balanceAfter: p.decimal('string').precision(20).scale(2),
    createdAt: p.datetime(),
  },
});

export type WalletLedgerEntryRecord = InferEntity<typeof WalletLedgerEntryRecord>;
