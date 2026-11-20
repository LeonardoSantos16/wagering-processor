import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { expectBalanceMatchesLedger } from '../support/wallet-invariants';
import { betFor, commandFor, defaultUnitOfWork, newWallet, wageringUseCases } from '../support/wagering';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { InboxMessageConflictError } from '../../src/application/errors/wager-transaction.errors';
import type { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/application/use-cases/process-wager-transaction.use-case';
import type { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';

const CONSUMER = 'test-consumer';

describe('ProcessWagerTransactionUseCase with inbox', () => {
  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;
  let createWallet: CreateWalletUseCase;
  let processTransaction: ProcessWagerTransactionUseCase;

  const viaQueue = (command: ProcessWagerTransactionCommand, messageId = `msg-${randomUUID()}`) => ({
    ...command,
    inbox: { consumerName: CONSUMER, messageId },
  });

  const inboxOf = (messageId: string) => unitOfWork.run(({ inbox }) => inbox.find(CONSUMER, messageId));
  const balanceOf = async (walletId: string) =>
    (await unitOfWork.run(({ wallets }) => wallets.findById(walletId)))!.balance.toJSON().amount;

  beforeAll(async () => {
    orm = await createTestOrm();
    unitOfWork = defaultUnitOfWork(orm);
    ({ createWallet, processTransaction } = wageringUseCases(orm, unitOfWork));
  });

  afterAll(async () => {
    await orm.close();
  });

  test('a new message is recorded in the inbox together with the processed transaction', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const command = viaQueue(betFor(wallet, '30.00'));

    const result = await processTransaction.execute(command);

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    const inbox = await inboxOf(command.inbox.messageId);
    expect(inbox).not.toBeNull();
    expect(inbox!.isProcessed()).toBe(true);
    expect(inbox!.payloadHash).toBe(result.transaction.payloadHash!);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a redelivered message is a replay without new effects', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const command = viaQueue(betFor(wallet, '30.00'));
    const first = await processTransaction.execute(command);
    const inboxBefore = await inboxOf(command.inbox.messageId);

    const redelivery = await processTransaction.execute(command);

    expect(redelivery.idempotentReplay).toBe(true);
    expect(redelivery.transaction.id).toBe(first.transaction.id);
    expect(await inboxOf(command.inbox.messageId)).toEqual(inboxBefore);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test.each([
    ['rejected', '500.00', WagerTransactionStatus.Rejected],
    ['pending reference', '30.00', WagerTransactionStatus.PendingReference],
  ])('a %s outcome is recorded in the inbox', async (_, amount, status) => {
    const wallet = await newWallet(createWallet, '100.00');
    const command =
      status === WagerTransactionStatus.Rejected
        ? viaQueue(betFor(wallet, amount))
        : viaQueue(
            commandFor(wallet, WagerTransactionKind.Refund, amount, {
              referenceExternalTransactionId: `tx-${randomUUID()}`,
            }),
          );

    const result = await processTransaction.execute(command);

    expect(result.transaction.status).toBe(status);
    expect((await inboxOf(command.inbox.messageId))?.isProcessed()).toBe(true);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a new message carrying an operation already done is a replay and is recorded in the inbox', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const operation = betFor(wallet, '30.00');
    const first = await processTransaction.execute(viaQueue(operation));

    const second = viaQueue(operation);
    const replay = await processTransaction.execute(second);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect((await inboxOf(second.inbox.messageId))?.isProcessed()).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('the same message id with a different payload is rejected without effects', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const original = viaQueue(betFor(wallet, '30.00'));
    await processTransaction.execute(original);

    const divergent = viaQueue(betFor(wallet, '10.00'), original.inbox.messageId);
    const outcome = processTransaction.execute(divergent);

    await expect(outcome).rejects.toBeInstanceOf(InboxMessageConflictError);
    const transaction = await unitOfWork.run(({ transactions }) =>
      transactions.findByIdempotencyKey(divergent.provider.providerId, divergent.provider.idempotencyKey),
    );
    expect(transaction).toBeNull();
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });
});
