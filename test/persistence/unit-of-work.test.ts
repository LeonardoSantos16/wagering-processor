import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ForeignKeyConstraintViolationException, type MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { Wallet } from '../../src/domain/wallet/wallet';
import { Money } from '../../src/domain/money/money';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import {
  DuplicateIdempotencyKeyError,
  ExternalTransactionConflictError,
  TemporarilyUnavailableError,
  WalletAlreadyExistsError,
} from '../../src/application/errors/persistence.errors';

describe('MikroOrmUnitOfWork', () => {
  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;

  const openWallet = (playerId = `player-${randomUUID()}`) => {
    const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
    const now = new Date('2026-01-01T10:00:00.000Z');
    const openingTransactionId = randomUUID();
    const { wallet, openingEntry } = Wallet.open({
      id: randomUUID(),
      playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: randomUUID(),
      now,
    });
    const openingTransaction = WagerTransaction.opening({
      id: openingTransactionId,
      walletId: wallet.id,
      playerId,
      money: initialBalance,
      now,
    });
    return { wallet, openingTransaction, openingEntry: openingEntry! };
  };

  beforeAll(async () => {
    orm = await createTestOrm();
    unitOfWork = new MikroOrmUnitOfWork(orm.em, { lockTimeoutMs: 2000 });
  });

  afterAll(async () => {
    await orm.close();
  });

  test('commits everything written inside run', async () => {
    const { wallet, openingTransaction, openingEntry } = openWallet();

    await unitOfWork.run(async ({ wallets, transactions, ledger }) => {
      await wallets.save(wallet);
      await transactions.save(openingTransaction);
      await ledger.append(openingEntry);
    });

    const persisted = await unitOfWork.run(async ({ wallets, transactions, ledger }) => ({
      wallet: await wallets.findById(wallet.id),
      transaction: await transactions.findById(openingTransaction.id),
      entries: await ledger.findByWallet(wallet.id),
    }));
    expect(persisted.wallet?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(persisted.transaction?.id).toBe(openingTransaction.id);
    expect(persisted.entries.map((entry) => entry.id)).toEqual([openingEntry.id]);
  });

  test('persists nothing when the work throws', async () => {
    const { wallet, openingTransaction, openingEntry } = openWallet();
    const failure = new Error('forced failure');

    const outcome = unitOfWork.run(async ({ wallets, transactions, ledger }) => {
      await wallets.save(wallet);
      await transactions.save(openingTransaction);
      await ledger.append(openingEntry);
      throw failure;
    });

    await expect(outcome).rejects.toBe(failure);
    const persisted = await unitOfWork.run(async ({ wallets, transactions, ledger }) => ({
      wallet: await wallets.findById(wallet.id),
      transaction: await transactions.findById(openingTransaction.id),
      entries: await ledger.findByWallet(wallet.id),
    }));
    expect(persisted).toEqual({ wallet: null, transaction: null, entries: [] });
  });

  test('waiting longer than the lock timeout for a locked wallet becomes TemporarilyUnavailableError', async () => {
    const { wallet, openingTransaction, openingEntry } = openWallet();
    await unitOfWork.run(async ({ wallets, transactions, ledger }) => {
      await wallets.save(wallet);
      await transactions.save(openingTransaction);
      await ledger.append(openingEntry);
    });
    const impatient = new MikroOrmUnitOfWork(orm.em, { lockTimeoutMs: 100 });

    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));
    let releaseLock!: () => void;
    const released = new Promise<void>((resolve) => (releaseLock = resolve));

    const holder = unitOfWork.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      lockAcquired();
      await released;
    });
    await acquired;

    const contender = impatient.run(({ wallets }) => wallets.findByIdForUpdate(wallet.id));

    await expect(contender).rejects.toBeInstanceOf(TemporarilyUnavailableError);
    releaseLock();
    await holder;
  });

  describe('translates unique violations by constraint name', () => {
    const persistOpenedWallet = async (playerId?: string) => {
      const opened = openWallet(playerId);
      await unitOfWork.run(async ({ wallets, transactions, ledger }) => {
        await wallets.save(opened.wallet);
        await transactions.save(opened.openingTransaction);
        await ledger.append(opened.openingEntry);
      });
      return opened.wallet;
    };

    const processedLoss = (
      wallet: Wallet,
      ids: { externalTransactionId: string; idempotencyKey: string },
    ) => {
      const transaction = WagerTransaction.create({
        id: randomUUID(),
        provider: { providerId: 'provider-a', roundId: 'round-1', gameId: 'game-1', ...ids },
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Loss,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        now: new Date('2026-01-01T10:00:01.000Z'),
      });
      transaction.markProcessed({ balanceAfter: wallet.balance, at: new Date('2026-01-01T10:00:01.000Z') });
      return transaction;
    };

    const saveTransaction = (transaction: WagerTransaction) =>
      unitOfWork.run(({ transactions }) => transactions.save(transaction));

    test('duplicate player and currency becomes WalletAlreadyExistsError', async () => {
      const existing = await persistOpenedWallet();
      const duplicate = openWallet(existing.playerId);

      const outcome = unitOfWork.run(({ wallets }) => wallets.save(duplicate.wallet));

      await expect(outcome).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    });

    test('reused external id with another key becomes ExternalTransactionConflictError', async () => {
      const wallet = await persistOpenedWallet();
      const externalTransactionId = `tx-${randomUUID()}`;
      await saveTransaction(processedLoss(wallet, { externalTransactionId, idempotencyKey: randomUUID() }));

      const outcome = saveTransaction(
        processedLoss(wallet, { externalTransactionId, idempotencyKey: randomUUID() }),
      );

      await expect(outcome).rejects.toBeInstanceOf(ExternalTransactionConflictError);
    });

    test('reused idempotency key becomes DuplicateIdempotencyKeyError', async () => {
      const wallet = await persistOpenedWallet();
      const idempotencyKey = randomUUID();
      await saveTransaction(processedLoss(wallet, { externalTransactionId: randomUUID(), idempotencyKey }));

      const outcome = saveTransaction(
        processedLoss(wallet, { externalTransactionId: randomUUID(), idempotencyKey }),
      );

      await expect(outcome).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
    });

    test('any other constraint violation is not translated', async () => {
      const { wallet } = openWallet();

      const outcome = saveTransaction(
        processedLoss(wallet, { externalTransactionId: randomUUID(), idempotencyKey: randomUUID() }),
      );

      await expect(outcome).rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
    });
  });
});
