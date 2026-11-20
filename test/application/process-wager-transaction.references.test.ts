import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { defaultPendingReferencePolicy } from '../support/wagering';
import { expectBalanceMatchesLedger, outboxEventsOfWallet } from '../support/wallet-invariants';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/application/use-cases/process-wager-transaction.use-case';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../src/infrastructure/system/uuid-v7-id-generator';
import { FailureCode } from '../../src/domain/errors/failure-code';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import type { Wallet } from '../../src/domain/wallet/wallet';

const { Bet, Win, Refund, Rollback } = WagerTransactionKind;

describe('ProcessWagerTransactionUseCase with references', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;
  let createWallet: CreateWalletUseCase;
  let useCase: ProcessWagerTransactionUseCase;

  const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

  const newWallet = (amount: string) =>
    createWallet.execute({ playerId: `player-${randomUUID()}`, initialBalance: brl(amount), correlationId: randomUUID() });

  const commandFor = (
    wallet: Wallet,
    kind: WagerTransactionKind,
    amount: string,
    referenceExternalTransactionId?: string,
    roundId = 'round-1',
  ): ProcessWagerTransactionCommand => {
    const externalTransactionId = `tx-${randomUUID()}`;
    return {
      provider: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        roundId,
        gameId: 'game-1',
      },
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind,
      money: brl(amount),
      referenceExternalTransactionId,
      correlationId: randomUUID(),
    };
  };

  const process = async (
    wallet: Wallet,
    kind: WagerTransactionKind,
    amount: string,
    reference?: ProcessWagerTransactionCommand,
    roundId?: string,
  ) => {
    const command = commandFor(wallet, kind, amount, reference?.provider.externalTransactionId, roundId);
    const { transaction } = await useCase.execute(command);
    return { command, transaction };
  };

  const entryOf = async (walletId: string, transactionId: string) =>
    (await unitOfWork.run(({ ledger }) => ledger.findByWallet(walletId))).filter(
      (entry) => entry.transactionId === transactionId,
    );
  const balanceOf = async (walletId: string) =>
    (await unitOfWork.run(({ wallets }) => wallets.findById(walletId)))!.balance.toJSON().amount;

  beforeAll(async () => {
    orm = await createTestOrm();
    unitOfWork = new MikroOrmUnitOfWork(orm.em, { lockTimeoutMs: 2000 });
    const ids = new UuidV7IdGenerator();
    const clock = { now: () => now };
    createWallet = new CreateWalletUseCase(unitOfWork, ids, clock);
    useCase = new ProcessWagerTransactionUseCase(unitOfWork, ids, clock, defaultPendingReferencePolicy());
  });

  afterAll(async () => {
    await orm.close();
  });

  test('a REFUND of a BET credits the amount back and records the reference', async () => {
    const wallet = await newWallet('100.00');
    const bet = await process(wallet, Bet, '30.00');

    const refund = await process(wallet, Refund, '30.00', bet.command);

    expect(refund.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(refund.transaction.balanceAfter?.toJSON().amount).toBe('100.00');
    expect((await entryOf(wallet.id, refund.transaction.id)).map((entry) => entry.direction)).toEqual([
      LedgerDirection.Credit,
    ]);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a ROLLBACK moves the balance in the opposite direction of its reference', async () => {
    const wallet = await newWallet('100.00');
    const bet = await process(wallet, Bet, '30.00');
    const win = await process(wallet, Win, '50.00');

    const betRollback = await process(wallet, Rollback, '30.00', bet.command);
    const winRollback = await process(wallet, Rollback, '50.00', win.command);

    expect((await entryOf(wallet.id, betRollback.transaction.id)).map((entry) => entry.direction)).toEqual([
      LedgerDirection.Credit,
    ]);
    expect((await entryOf(wallet.id, winRollback.transaction.id)).map((entry) => entry.direction)).toEqual([
      LedgerDirection.Debit,
    ]);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a ROLLBACK that would make the balance negative is rejected with REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await newWallet('0.00');
    const win = await process(wallet, Win, '50.00');
    await process(wallet, Bet, '40.00');

    const rollback = await process(wallet, Rollback, '50.00', win.command);

    expect(rollback.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.transaction.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rollback.transaction.balanceAfter?.toJSON().amount).toBe('10.00');
    expect(await balanceOf(wallet.id)).toBe('10.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a transaction already reversed cannot be reversed again by any kind', async () => {
    const wallet = await newWallet('100.00');
    const bet = await process(wallet, Bet, '30.00');
    await process(wallet, Refund, '30.00', bet.command);

    const rollback = await process(wallet, Rollback, '30.00', bet.command);

    expect(rollback.transaction.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a ROLLBACK of a REFUND is allowed, because it reverts another transaction', async () => {
    const wallet = await newWallet('100.00');
    const bet = await process(wallet, Bet, '30.00');
    const refund = await process(wallet, Refund, '30.00', bet.command);

    const rollback = await process(wallet, Rollback, '30.00', refund.command);

    expect(rollback.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('an unknown reference leaves the transaction PENDING_REFERENCE without touching the wallet', async () => {
    const wallet = await newWallet('100.00');
    const command = commandFor(wallet, Refund, '30.00', `missing-${randomUUID()}`);

    const { transaction } = await useCase.execute(command);

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.balanceAfter).toBeUndefined();
    expect(transaction.nextReferenceAttemptAt?.toISOString()).toBe('2026-01-01T10:00:01.000Z');
    expect(await balanceOf(wallet.id)).toBe('100.00');
    const events = (await outboxEventsOfWallet(orm, wallet.id)).filter(
      (event) => event.data.transactionId === transaction.id,
    );
    expect(events.map((event) => event.eventType)).toEqual(['WagerTransactionPendingReference']);

    const replay = await useCase.execute(command);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a reference from another round is rejected with REFERENCE_MISMATCH', async () => {
    const wallet = await newWallet('100.00');
    const bet = await process(wallet, Bet, '30.00', undefined, 'round-1');

    const refund = await process(wallet, Refund, '30.00', bet.command, 'round-2');

    expect(refund.transaction.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(refund.transaction.balanceAfter?.toJSON().amount).toBe('70.00');
  });

  test('a REFUND of a WIN is rejected with INVALID_REFERENCE_KIND', async () => {
    const wallet = await newWallet('100.00');
    const win = await process(wallet, Win, '30.00');

    const refund = await process(wallet, Refund, '30.00', win.command);

    expect(refund.transaction.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('a reference that was rejected is REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await newWallet('10.00');
    const bet = await process(wallet, Bet, '50.00');

    const refund = await process(wallet, Refund, '50.00', bet.command);

    expect(bet.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.transaction.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('a reversal with another amount is rejected with AMOUNT_MISMATCH', async () => {
    const wallet = await newWallet('100.00');
    const bet = await process(wallet, Bet, '30.00');

    const refund = await process(wallet, Refund, '20.00', bet.command);

    expect(refund.transaction.failureCode).toBe(FailureCode.AmountMismatch);
    expect(await balanceOf(wallet.id)).toBe('70.00');
  });

  test('a WIN referencing its BET is processed and does not consume the BET', async () => {
    const wallet = await newWallet('100.00');
    const bet = await process(wallet, Bet, '30.00');

    const win = await process(wallet, Win, '75.00', bet.command);
    const refund = await process(wallet, Refund, '30.00', bet.command);

    expect(win.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(win.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(refund.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet.id)).toBe('175.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });
});
