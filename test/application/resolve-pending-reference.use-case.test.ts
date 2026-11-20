import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { commandFor, defaultUnitOfWork, newWallet } from '../support/wagering';
import { expectBalanceMatchesLedger, outboxEventsOfWallet } from '../support/wallet-invariants';
import { PendingReferencePolicy } from '../../src/application/services/pending-reference-policy';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/application/use-cases/process-wager-transaction.use-case';
import {
  type PendingReferenceRef,
  ResolvePendingReferenceUseCase,
} from '../../src/application/use-cases/resolve-pending-reference.use-case';
import { FailureCode } from '../../src/domain/errors/failure-code';
import type { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import type { Wallet } from '../../src/domain/wallet/wallet';
import type { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../src/infrastructure/system/uuid-v7-id-generator';

const { Bet, Win, Rollback, Refund } = WagerTransactionKind;
const TTL_MS = 10 * 60_000;

describe('ResolvePendingReferenceUseCase', () => {
  const start = new Date('2026-01-01T10:00:00.000Z');
  let current = start;
  const clock = { now: () => current };
  const advanceTo = (ms: number) => {
    current = new Date(start.getTime() + ms);
  };

  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;
  let createWallet: CreateWalletUseCase;
  let processTransaction: ProcessWagerTransactionUseCase;
  let resolvePendingReference: ResolvePendingReferenceUseCase;

  const pendingRollbackOf = async (wallet: Wallet, bet: ProcessWagerTransactionCommand) => {
    const rollback = commandFor(wallet, Rollback, bet.money.toJSON().amount, {
      referenceExternalTransactionId: bet.provider.externalTransactionId,
    });
    const { transaction } = await processTransaction.execute(rollback);
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    return transaction;
  };
  const refOf = (transaction: WagerTransaction): PendingReferenceRef => ({
    transactionId: transaction.id,
    walletId: transaction.walletId,
  });
  const reload = async (transaction: WagerTransaction) =>
    (await unitOfWork.run(({ transactions }) => transactions.findById(transaction.id)))!;
  const ledgerOf = (walletId: string) => unitOfWork.run(({ ledger }) => ledger.findByWallet(walletId));
  const eventTypesOf = async (walletId: string, transactionId: string) =>
    (await outboxEventsOfWallet(orm, walletId))
      .filter((event) => event.data.transactionId === transactionId)
      .map((event) => event.eventType);

  beforeAll(async () => {
    orm = await createTestOrm();
    unitOfWork = defaultUnitOfWork(orm);
    const ids = new UuidV7IdGenerator();
    const policy = new PendingReferencePolicy({ ttlMs: TTL_MS });
    createWallet = new CreateWalletUseCase(unitOfWork, ids, clock);
    processTransaction = new ProcessWagerTransactionUseCase(unitOfWork, ids, clock, policy);
    resolvePendingReference = new ResolvePendingReferenceUseCase(unitOfWork, ids, clock, policy);
  });

  beforeEach(() => {
    current = start;
  });

  afterAll(async () => {
    await orm.close();
  });

  test('processes the transaction once its reference arrives', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const bet = commandFor(wallet, Bet, '30.00');
    const rollback = await pendingRollbackOf(wallet, bet);
    const { transaction: betTransaction } = await processTransaction.execute(bet);

    advanceTo(1_000);
    const result = await resolvePendingReference.execute(refOf(rollback));

    expect(result.outcome).toBe('resolved');
    const resolved = await reload(rollback);
    expect(resolved.status).toBe(WagerTransactionStatus.Processed);
    expect(resolved.referenceTransactionId).toBe(betTransaction.id);
    expect(resolved.balanceAfter?.toJSON().amount).toBe('100.00');
    expect((await ledgerOf(wallet.id)).filter((entry) => entry.transactionId === rollback.id)).toHaveLength(1);
    expect(await eventTypesOf(wallet.id, rollback.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('reschedules with backoff while the reference is missing, without any event', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const rollback = await pendingRollbackOf(wallet, commandFor(wallet, Bet, '30.00'));

    advanceTo(1_000);
    const first = await resolvePendingReference.execute(refOf(rollback));
    advanceTo(3_000);
    const second = await resolvePendingReference.execute(refOf(rollback));

    expect([first.outcome, second.outcome]).toEqual(['rescheduled', 'rescheduled']);
    const pending = await reload(rollback);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending.referenceAttempts).toBe(2);
    expect(pending.nextReferenceAttemptAt).toEqual(new Date(start.getTime() + 3_000 + 4_000));
    expect(await eventTypesOf(wallet.id, rollback.id)).toEqual(['WagerTransactionPendingReference']);
  });

  test('never schedules the next attempt after the deadline', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const rollback = await pendingRollbackOf(wallet, commandFor(wallet, Bet, '30.00'));

    advanceTo(TTL_MS - 500);
    await resolvePendingReference.execute(refOf(rollback));

    expect((await reload(rollback)).nextReferenceAttemptAt).toEqual(new Date(start.getTime() + TTL_MS));
  });

  test('rejects with REFERENCE_NOT_FOUND once the TTL expires', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const rollback = await pendingRollbackOf(wallet, commandFor(wallet, Bet, '30.00'));

    advanceTo(TTL_MS);
    const result = await resolvePendingReference.execute(refOf(rollback));

    expect(result.outcome).toBe('resolved');
    const rejected = await reload(rollback);
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(rejected.balanceAfter?.toJSON().amount).toBe('100.00');
    expect(await ledgerOf(wallet.id)).toHaveLength(1);
    expect(await eventTypesOf(wallet.id, rollback.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('looks for the reference one last time before rejecting', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const bet = commandFor(wallet, Bet, '30.00');
    const rollback = await pendingRollbackOf(wallet, bet);
    await processTransaction.execute(bet);

    advanceTo(TTL_MS + 60_000);
    await resolvePendingReference.execute(refOf(rollback));

    expect((await reload(rollback)).status).toBe(WagerTransactionStatus.Processed);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('rejects by the business rules when the reference arrives but does not match', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const win = commandFor(wallet, Win, '30.00');
    const refund = commandFor(wallet, Refund, '30.00', {
      referenceExternalTransactionId: win.provider.externalTransactionId,
    });
    const { transaction: pending } = await processTransaction.execute(refund);
    await processTransaction.execute(win);

    advanceTo(1_000);
    await resolvePendingReference.execute(refOf(pending));

    const rejected = await reload(pending);
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InvalidReferenceKind);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('skips a transaction that is not due yet or is already resolved', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const rollback = await pendingRollbackOf(wallet, commandFor(wallet, Bet, '30.00'));

    advanceTo(999);
    expect((await resolvePendingReference.execute(refOf(rollback))).outcome).toBe('skipped');

    advanceTo(TTL_MS);
    await resolvePendingReference.execute(refOf(rollback));
    expect((await resolvePendingReference.execute(refOf(rollback))).outcome).toBe('skipped');
    expect((await reload(rollback)).referenceAttempts).toBe(0);
  });

  test('findDue returns only pending transactions whose next attempt is due', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const rollback = await pendingRollbackOf(wallet, commandFor(wallet, Bet, '30.00'));

    advanceTo(999);
    const early = await resolvePendingReference.findDue(10_000);
    advanceTo(1_000);
    const due = await resolvePendingReference.findDue(10_000);

    expect(early.map((ref) => ref.transactionId)).not.toContain(rollback.id);
    expect(due).toContainEqual(refOf(rollback));
  });

  test('parallel workers resolve the transaction once', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const bet = commandFor(wallet, Bet, '30.00');
    const rollback = await pendingRollbackOf(wallet, bet);
    await processTransaction.execute(bet);

    advanceTo(1_000);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => resolvePendingReference.execute(refOf(rollback))),
    );

    expect(results.filter((result) => result.outcome === 'resolved')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'skipped')).toHaveLength(9);
    expect((await ledgerOf(wallet.id)).filter((entry) => entry.transactionId === rollback.id)).toHaveLength(1);
    expect(
      (await eventTypesOf(wallet.id, rollback.id)).filter((type) => type === 'WagerTransactionProcessed'),
    ).toHaveLength(1);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });
});
