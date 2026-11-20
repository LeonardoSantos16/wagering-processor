import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, rawSql } from '../support/database';
import { FailingOnOutboxUnitOfWork, ForcedFailure } from '../support/failing-unit-of-work';
import { expectBalanceMatchesLedger, outboxEventsOfWallet } from '../support/wallet-invariants';
import { betFor, brl, defaultUnitOfWork, newWallet, wageringUseCases } from '../support/wagering';
import type { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import type { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import type { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';

describe('wallet, ledger and outbox atomicity', () => {
  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;
  let failing: FailingOnOutboxUnitOfWork;
  let createWallet: CreateWalletUseCase;
  let processTransaction: ProcessWagerTransactionUseCase;
  let failingCreateWallet: CreateWalletUseCase;
  let failingProcessTransaction: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    orm = await createTestOrm();
    unitOfWork = defaultUnitOfWork(orm);
    failing = new FailingOnOutboxUnitOfWork(unitOfWork);
    ({ createWallet, processTransaction } = wageringUseCases(orm, unitOfWork));
    ({ createWallet: failingCreateWallet, processTransaction: failingProcessTransaction } = wageringUseCases(
      orm,
      failing,
    ));
  });

  afterAll(async () => {
    await orm.close();
  });

  test('a failure after the debit was written rolls back transaction, wallet, ledger and outbox', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const command = betFor(wallet, '30.00');
    const eventsBefore = await outboxEventsOfWallet(orm, wallet.id);

    await expect(failingProcessTransaction.execute(command)).rejects.toBeInstanceOf(ForcedFailure);

    const seen = failing.seen.find((writes) => writes.walletId === wallet.id)!;
    expect(seen.ledgerEntryIds).toHaveLength(2);
    const after = await unitOfWork.run(async ({ wallets, transactions, ledger }) => ({
      wallet: await wallets.findById(wallet.id),
      transaction: await transactions.findByIdempotencyKey(
        command.provider.providerId,
        command.provider.idempotencyKey,
      ),
      entries: await ledger.findByWallet(wallet.id),
    }));
    expect(after.wallet!.balance.toJSON().amount).toBe('100.00');
    expect(after.wallet!.version).toBe(wallet.version);
    expect(after.transaction).toBeNull();
    expect(after.entries).toHaveLength(1);
    expect(await outboxEventsOfWallet(orm, wallet.id)).toEqual(eventsBefore);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('the same request succeeds normally after the failed attempt', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const command = betFor(wallet, '30.00');
    await expect(failingProcessTransaction.execute(command)).rejects.toBeInstanceOf(ForcedFailure);

    const retry = await processTransaction.execute(command);

    expect(retry.idempotentReplay).toBe(false);
    expect(retry.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(retry.transaction.balanceAfter?.toJSON().amount).toBe('70.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a failure while opening a wallet leaves no wallet, opening transaction, ledger or outbox', async () => {
    const playerId = `player-${crypto.randomUUID()}`;

    const outcome = failingCreateWallet.execute({
      playerId,
      initialBalance: brl('100.00'),
      correlationId: crypto.randomUUID(),
    });

    await expect(outcome).rejects.toBeInstanceOf(ForcedFailure);
    const walletId = failing.seen.at(-1)!.walletId;
    expect(failing.seen.at(-1)!.ledgerEntryIds).toHaveLength(1);
    const after = await unitOfWork.run(async ({ wallets, ledger }) => ({
      wallet: await wallets.findById(walletId),
      entries: await ledger.findByWallet(walletId),
    }));
    expect(after.wallet).toBeNull();
    expect(after.entries).toHaveLength(0);
    expect(await rawSql(orm, 'select id from wager_transaction where wallet_id = ?', [walletId])).toHaveLength(0);
    expect(await outboxEventsOfWallet(orm, walletId)).toHaveLength(0);
  });
});
