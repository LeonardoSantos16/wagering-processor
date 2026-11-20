import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { expectBalanceMatchesLedger, outboxEventsOfWallet } from '../support/wallet-invariants';
import { betFor, brl, commandFor, defaultUnitOfWork, deferred, newWallet, wageringUseCases } from '../support/wagering';
import type { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import type { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import type { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { FailureCode } from '../../src/domain/errors/failure-code';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';

describe('ProcessWagerTransactionUseCase under concurrency', () => {
  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;
  let createWallet: CreateWalletUseCase;
  let processTransaction: ProcessWagerTransactionUseCase;

  const ledgerOf = (walletId: string) => unitOfWork.run(({ ledger }) => ledger.findByWallet(walletId));
  const balanceOf = async (walletId: string) =>
    (await unitOfWork.run(({ wallets }) => wallets.findById(walletId)))!.balance.toJSON().amount;
  const debitsOf = async (walletId: string) =>
    (await ledgerOf(walletId)).filter((entry) => entry.direction === LedgerDirection.Debit);

  beforeAll(async () => {
    orm = await createTestOrm();
    unitOfWork = defaultUnitOfWork(orm);
    ({ createWallet, processTransaction } = wageringUseCases(orm, unitOfWork));
  });

  afterAll(async () => {
    await orm.close();
  });

  test('the same BET sent 50 times in parallel debits the wallet once', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const command = betFor(wallet, '10.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => processTransaction.execute(command)));

    const originals = results.filter((result) => !result.idempotentReplay);
    expect(originals).toHaveLength(1);
    const original = originals[0]!.transaction;
    expect(original.status).toBe(WagerTransactionStatus.Processed);
    for (const { transaction } of results) {
      expect(transaction.id).toBe(original.id);
      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.balanceAfter?.toJSON().amount).toBe('90.00');
    }
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect((await debitsOf(wallet.id)).map((entry) => entry.transactionId)).toEqual([original.id]);
    const events = (await outboxEventsOfWallet(orm, wallet.id)).filter(
      (event) => event.data.transactionId === original.id,
    );
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('two BETs of 80 against a balance of 100 at the same time: one processed, one rejected', async () => {
    const wallet = await newWallet(createWallet, '100.00');

    const results = await Promise.all([
      processTransaction.execute(betFor(wallet, '80.00')),
      processTransaction.execute(betFor(wallet, '80.00')),
    ]);

    const statuses = results.map(({ transaction }) => transaction.status).sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    const processed = results.find(({ transaction }) => transaction.status === WagerTransactionStatus.Processed)!;
    const rejected = results.find(({ transaction }) => transaction.status === WagerTransactionStatus.Rejected)!;
    expect(processed.transaction.balanceAfter?.toJSON().amount).toBe('20.00');
    expect(rejected.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected.transaction.balanceAfter?.toJSON().amount).toBe('20.00');
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect((await debitsOf(wallet.id)).map((entry) => entry.transactionId)).toEqual([processed.transaction.id]);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('30 parallel BETs of 10 against a balance of 100 process exactly 10 and never go negative', async () => {
    const wallet = await newWallet(createWallet, '100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, () => processTransaction.execute(betFor(wallet, '10.00'))),
    );

    const processed = results.filter(({ transaction }) => transaction.status === WagerTransactionStatus.Processed);
    const rejected = results.filter(({ transaction }) => transaction.status === WagerTransactionStatus.Rejected);
    expect(processed).toHaveLength(10);
    expect(rejected).toHaveLength(20);
    expect(rejected.every(({ transaction }) => transaction.failureCode === FailureCode.InsufficientFunds)).toBe(true);
    const balancesAfter = processed.map(({ transaction }) => transaction.balanceAfter!.toJSON().amount).sort();
    expect(balancesAfter).toEqual(['0.00', '10.00', '20.00', '30.00', '40.00', '50.00', '60.00', '70.00', '80.00', '90.00']);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    expect(await debitsOf(wallet.id)).toHaveLength(10);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('parallel BETs and WINs on the same wallet add up to the expected balance', async () => {
    const wallet = await newWallet(createWallet, '50.00');
    const commands = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0 ? betFor(wallet, '5.00') : commandFor(wallet, WagerTransactionKind.Win, '7.50'),
    );

    const results = await Promise.all(commands.map((command) => processTransaction.execute(command)));

    expect(results.every(({ transaction }) => transaction.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(await balanceOf(wallet.id)).toBe(brl('50.00').add(brl('25.00')).toJSON().amount);
    expect(await ledgerOf(wallet.id)).toHaveLength(21);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('distinct wallets are processed in parallel, each one consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet(createWallet, '100.00')));

    await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 5 }, () => processTransaction.execute(betFor(wallet, '15.00')))),
    );

    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('25.00');
      expect(await debitsOf(wallet.id)).toHaveLength(5);
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
    }
  });

  test('a held lock on one wallet blocks only that wallet, not the others', async () => {
    const [locked, free] = await Promise.all([newWallet(createWallet, '100.00'), newWallet(createWallet, '100.00')]);
    const lockAcquired = deferred();
    const release = deferred();
    const holder = unitOfWork.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(locked.id);
      lockAcquired.resolve();
      await release.promise;
    });
    await lockAcquired.promise;

    let lockedSettled = false;
    const onLocked = processTransaction.execute(betFor(locked, '10.00')).finally(() => {
      lockedSettled = true;
    });
    const onFree = await processTransaction.execute(betFor(free, '10.00'));

    expect(onFree.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(lockedSettled).toBe(false);
    release.resolve();
    await holder;
    expect((await onLocked).transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(locked.id)).toBe('90.00');
    expect(await balanceOf(free.id)).toBe('90.00');
    await expectBalanceMatchesLedger(unitOfWork, locked.id);
    await expectBalanceMatchesLedger(unitOfWork, free.id);
  });
});
