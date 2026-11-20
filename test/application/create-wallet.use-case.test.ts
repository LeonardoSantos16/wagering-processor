import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { expectBalanceMatchesLedger, outboxEventsOfWallet } from '../support/wallet-invariants';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { WalletAlreadyExistsError } from '../../src/application/errors/persistence.errors';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../src/infrastructure/system/uuid-v7-id-generator';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';

describe('CreateWalletUseCase', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;
  let useCase: CreateWalletUseCase;

  const command = (amount: string, playerId = `player-${randomUUID()}`) => ({
    playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    correlationId: `corr-${randomUUID()}`,
  });

  const persistedState = (walletId: string) =>
    unitOfWork.run(async ({ wallets, ledger }) => ({
      wallet: await wallets.findById(walletId),
      entries: await ledger.findByWallet(walletId),
    }));

  beforeAll(async () => {
    orm = await createTestOrm();
    unitOfWork = new MikroOrmUnitOfWork(orm.em, { lockTimeoutMs: 2000 });
    useCase = new CreateWalletUseCase(unitOfWork, new UuidV7IdGenerator(), { now: () => now });
  });

  afterAll(async () => {
    await orm.close();
  });

  test('a positive initial balance opens the wallet with an OPENING transaction, a credit and two events', async () => {
    const input = command('1000.00');

    const wallet = await useCase.execute(input);

    expect(wallet.playerId).toBe(input.playerId);
    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);

    const { wallet: stored, entries } = await persistedState(wallet.id);
    expect(stored?.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe(LedgerDirection.Credit);
    expect(entries[0]!.money.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });

    const opening = await unitOfWork.run(({ transactions }) => transactions.findById(entries[0]!.transactionId));
    expect(opening?.kind).toBe(WagerTransactionKind.Opening);
    expect(opening?.status).toBe(WagerTransactionStatus.Processed);

    const events = await outboxEventsOfWallet(orm, wallet.id);
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of events) {
      expect(event.correlationId).toBe(input.correlationId);
      expect(event.causationId).toBeUndefined();
      expect(event.occurredAt).toBe(now.toISOString());
    }

    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a zero initial balance opens only the wallet', async () => {
    const wallet = await useCase.execute(command('0.00'));

    const { wallet: stored, entries } = await persistedState(wallet.id);
    expect(stored?.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(entries).toEqual([]);
    expect(await outboxEventsOfWallet(orm, wallet.id)).toEqual([]);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a second wallet for the same player and currency is a conflict and persists nothing', async () => {
    const first = command('100.00');
    const existing = await useCase.execute(first);

    const outcome = useCase.execute(command('50.00', first.playerId));

    await expect(outcome).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    const { wallet: stored, entries } = await persistedState(existing.id);
    expect(stored?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entries).toHaveLength(1);
  });
});
