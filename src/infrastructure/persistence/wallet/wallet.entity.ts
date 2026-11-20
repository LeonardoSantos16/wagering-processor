import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallet',
  uniques: [
    { name: 'wallet_player_currency_unique', properties: ['playerId', 'currency'] },
    { name: 'wallet_id_currency_unique', properties: ['id', 'currency'] },
  ],
  checks: [
    { name: 'wallet_balance_non_negative_check', expression: 'balance >= 0' },
    { name: 'wallet_version_positive_check', expression: 'version >= 1' },
    { name: 'wallet_currency_format_check', expression: "currency ~ '^[A-Z]{3}$'" },
    {
      name: 'wallet_player_id_length_check',
      expression: 'char_length(player_id) >= 1 and char_length(player_id) <= 255',
    },
  ],
  properties: {
    id: p.uuid().primary(),
    playerId: p.text(),
    currency: p.string().columnType('char(3)'),
    balance: p.decimal('string').precision(20).scale(2),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export type WalletRecord = InferEntity<typeof WalletRecord>;
