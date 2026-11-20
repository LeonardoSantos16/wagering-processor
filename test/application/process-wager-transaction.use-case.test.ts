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
import { ExternalTransactionConflictError } from '../../src/application/errors/persistence.errors';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../src/application/errors/wager-transaction.errors';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../src/infrastructure/system/uuid-v7-id-generator';
import { FailureCode } from '../../src/domain/errors/failure-code';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import type { Wallet } from '../../src/domain/wallet/wallet';

describe('ProcessWagerTransactionUseCase', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;
  let createWallet: CreateWalletUseCase;
  let useCase: ProcessWagerTransactionUseCase;

  const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

  const newWallet = (amount: string) =>
    createWallet.execute({
      playerId: `player-${randomUUID()}`,
      initialBalance: brl(amount),
      correlationId: randomUUID(),
    });

  const commandFor = (
    wallet: Wallet,
    kind: WagerTransactionKind,
    amount: string,
    overrides: Partial<ProcessWagerTransactionCommand> = {},
  ): ProcessWagerTransactionCommand => {
    const externalTransactionId = `tx-${randomUUID()}`;
    return {
      provider: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        roundId: 'round-1',
        gameId: 'game-1',
      },
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind,
      money: brl(amount),
      correlationId: `corr-${randomUUID()}`,
      ...overrides,
    };
  };

  const ledgerOf = (walletId: string) => unitOfWork.run(({ ledger }) => ledger.findByWallet(walletId));
  const balanceOf = async (walletId: string) =>
    (await unitOfWork.run(({ wallets }) => wallets.findById(walletId)))!.balance.toJSON();
  const eventTypesOf = async (walletId: string, transactionId: string) =>
    (await outboxEventsOfWallet(orm, walletId))
      .filter((event) => event.data.transactionId === transactionId)
      .map((event) => event.eventType)
      .sort();

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

  describe('new transactions', () => {
    test('a BET within the balance is processed and debits the wallet', async () => {
      const wallet = await newWallet('100.00');

      const { transaction, idempotentReplay } = await useCase.execute(
        commandFor(wallet, WagerTransactionKind.Bet, '25.00'),
      );

      expect(idempotentReplay).toBe(false);
      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.balanceAfter?.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(await balanceOf(wallet.id)).toEqual({ amount: '75.00', currency: 'BRL' });
      const debits = (await ledgerOf(wallet.id)).filter((entry) => entry.transactionId === transaction.id);
      expect(debits.map((entry) => [entry.direction, entry.money.toJSON().amount])).toEqual([
        [LedgerDirection.Debit, '25.00'],
      ]);
      expect(await eventTypesOf(wallet.id, transaction.id)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
    });

    test('a BET above the balance is rejected with INSUFFICIENT_FUNDS and moves nothing', async () => {
      const wallet = await newWallet('10.00');

      const { transaction } = await useCase.execute(commandFor(wallet, WagerTransactionKind.Bet, '10.01'));

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(transaction.balanceAfter?.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
      expect(await balanceOf(wallet.id)).toEqual({ amount: '10.00', currency: 'BRL' });
      expect((await ledgerOf(wallet.id)).some((entry) => entry.transactionId === transaction.id)).toBe(false);
      expect(await eventTypesOf(wallet.id, transaction.id)).toEqual(['WagerTransactionRejected']);
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
    });

    test('a WIN credits the wallet', async () => {
      const wallet = await newWallet('100.00');

      const { transaction } = await useCase.execute(commandFor(wallet, WagerTransactionKind.Win, '40.00'));

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.balanceAfter?.toJSON()).toEqual({ amount: '140.00', currency: 'BRL' });
      const credits = (await ledgerOf(wallet.id)).filter((entry) => entry.transactionId === transaction.id);
      expect(credits.map((entry) => entry.direction)).toEqual([LedgerDirection.Credit]);
      expect(await eventTypesOf(wallet.id, transaction.id)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
    });

    test('a LOSS is processed without moving the balance or writing the ledger', async () => {
      const wallet = await newWallet('100.00');

      const { transaction } = await useCase.execute(commandFor(wallet, WagerTransactionKind.Loss, '25.00'));

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.balanceAfter?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect((await ledgerOf(wallet.id)).some((entry) => entry.transactionId === transaction.id)).toBe(false);
      expect(await eventTypesOf(wallet.id, transaction.id)).toEqual(['WagerTransactionProcessed']);
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
    });

    test('a currency other than the wallet one is rejected with CURRENCY_MISMATCH and no balance', async () => {
      const wallet = await newWallet('100.00');

      const { transaction } = await useCase.execute(
        commandFor(wallet, WagerTransactionKind.Bet, '10.00', {
          money: Money.from({ amount: '10.00', currency: 'USD' }),
          playerId: `other-${randomUUID()}`,
        }),
      );

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(transaction.balanceAfter).toBeUndefined();
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
    });

    test('a wallet of another player is rejected with PLAYER_WALLET_MISMATCH', async () => {
      const wallet = await newWallet('100.00');

      const { transaction } = await useCase.execute(
        commandFor(wallet, WagerTransactionKind.Bet, '10.00', { playerId: `other-${randomUUID()}` }),
      );

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.PlayerWalletMismatch);
      expect(transaction.balanceAfter?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(await balanceOf(wallet.id)).toEqual({ amount: '100.00', currency: 'BRL' });
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
    });

    test('an unknown wallet fails with WalletNotFoundError and records nothing', async () => {
      const wallet = await newWallet('100.00');
      const command = commandFor(wallet, WagerTransactionKind.Bet, '10.00', { walletId: randomUUID() });

      await expect(useCase.execute(command)).rejects.toBeInstanceOf(WalletNotFoundError);
      const recorded = await unitOfWork.run(({ transactions }) =>
        transactions.findByIdempotencyKey(command.provider.providerId, command.provider.idempotencyKey),
      );
      expect(recorded).toBeNull();
    });
  });

  describe('idempotency', () => {
    test('repeating a processed request replays the original result and balance', async () => {
      const wallet = await newWallet('100.00');
      const command = commandFor(wallet, WagerTransactionKind.Bet, '30.00');
      const original = await useCase.execute(command);
      await useCase.execute(commandFor(wallet, WagerTransactionKind.Bet, '20.00'));

      const replay = await useCase.execute({ ...command, correlationId: randomUUID() });

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(original.transaction.id);
      expect(replay.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(replay.transaction.balanceAfter?.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
      expect(await balanceOf(wallet.id)).toEqual({ amount: '50.00', currency: 'BRL' });
      const entries = (await ledgerOf(wallet.id)).filter((entry) => entry.transactionId === original.transaction.id);
      expect(entries).toHaveLength(1);
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
    });

    test('repeating a rejected request replays the rejection', async () => {
      const wallet = await newWallet('10.00');
      const command = commandFor(wallet, WagerTransactionKind.Bet, '50.00');
      const original = await useCase.execute(command);

      const replay = await useCase.execute(command);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(original.transaction.id);
      expect(replay.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    test('the same key with a different payload is an IdempotencyConflictError', async () => {
      const wallet = await newWallet('100.00');
      const command = commandFor(wallet, WagerTransactionKind.Bet, '10.00');
      await useCase.execute(command);

      const outcome = useCase.execute({ ...command, money: brl('11.00') });

      await expect(outcome).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await balanceOf(wallet.id)).toEqual({ amount: '90.00', currency: 'BRL' });
    });

    test('the same external id under another key is an ExternalTransactionConflictError', async () => {
      const wallet = await newWallet('100.00');
      const command = commandFor(wallet, WagerTransactionKind.Bet, '10.00');
      await useCase.execute(command);

      const outcome = useCase.execute({
        ...command,
        provider: { ...command.provider, idempotencyKey: randomUUID() },
      });

      await expect(outcome).rejects.toBeInstanceOf(ExternalTransactionConflictError);
      expect(await balanceOf(wallet.id)).toEqual({ amount: '90.00', currency: 'BRL' });
    });

    test('the same key sent to two wallets at once is recorded once and the other is a conflict', async () => {
      const [first, second] = await Promise.all([newWallet('100.00'), newWallet('100.00')]);
      const command = commandFor(first, WagerTransactionKind.Bet, '10.00');
      const sameKeyOnSecond: ProcessWagerTransactionCommand = {
        ...command,
        walletId: second.id,
        playerId: second.playerId,
      };

      const outcomes = await Promise.allSettled([useCase.execute(command), useCase.execute(sameKeyOnSecond)]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyConflictError);
      const balances = [await balanceOf(first.id), await balanceOf(second.id)].map((money) => money.amount).sort();
      expect(balances).toEqual(['100.00', '90.00']);
      await expectBalanceMatchesLedger(unitOfWork, first.id);
      await expectBalanceMatchesLedger(unitOfWork, second.id);
    });
  });
});
