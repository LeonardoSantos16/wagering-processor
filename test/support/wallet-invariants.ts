import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import type { IntegrationEventEnvelope } from '../../src/domain/events/integration-event';
import { rawSql } from './database';

export async function expectBalanceMatchesLedger(unitOfWork: UnitOfWork, walletId: string): Promise<void> {
  const { wallet, entries } = await unitOfWork.run(async ({ wallets, ledger }) => ({
    wallet: await wallets.findById(walletId),
    entries: await ledger.findByWallet(walletId),
  }));
  expect(wallet).not.toBeNull();
  const replayed = entries.reduce(
    (balance, entry) =>
      entry.direction === LedgerDirection.Credit ? balance.add(entry.money) : balance.subtract(entry.money),
    Money.zero(wallet!.currency),
  );
  expect(replayed.toJSON()).toEqual(wallet!.balance.toJSON());
}

export async function outboxEventsOfWallet(
  orm: MikroORM,
  walletId: string,
): Promise<IntegrationEventEnvelope<Record<string, unknown>>[]> {
  const rows = (await rawSql(
    orm,
    `select payload from outbox_message where payload->'data'->>'walletId' = ? order by occurred_at, id`,
    [walletId],
  )) as { payload: IntegrationEventEnvelope<Record<string, unknown>> }[];
  return rows.map((row) => row.payload);
}
