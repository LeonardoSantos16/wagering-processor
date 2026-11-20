import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, rawSql } from '../support/database';
import { betFor, commandFor, defaultUnitOfWork, newWallet, wageringUseCases } from '../support/wagering';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';

describe('ReconcileWalletUseCase', () => {
  let orm: MikroORM;
  let useCases: ReturnType<typeof wageringUseCases>;
  let reconcile: ReconcileWalletUseCase;

  const json = (result: Awaited<ReturnType<ReconcileWalletUseCase['execute']>>) =>
    result && {
      ...result,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
    };

  beforeAll(async () => {
    orm = await createTestOrm();
    useCases = wageringUseCases(orm);
    reconcile = new ReconcileWalletUseCase(defaultUnitOfWork(orm));
  });

  afterAll(async () => {
    await orm.close();
  });

  test('a wallet whose balance matches the ledger is consistent', async () => {
    const wallet = await newWallet(useCases.createWallet, '100.00');
    await useCases.processTransaction.execute(betFor(wallet, '30.00'));
    await useCases.processTransaction.execute(commandFor(wallet, WagerTransactionKind.Win, '12.50'));

    expect(json(await reconcile.execute(wallet.id))).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '82.50', currency: 'BRL' },
      calculatedBalance: { amount: '82.50', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test('a stored balance changed outside the ledger is reported, not corrected', async () => {
    const wallet = await newWallet(useCases.createWallet, '100.00');
    await useCases.processTransaction.execute(betFor(wallet, '30.00'));
    await rawSql(orm, 'update wallet set balance = ? where id = ?', ['65.00', wallet.id]);

    const result = json(await reconcile.execute(wallet.id));

    expect(result).toMatchObject({
      storedBalance: { amount: '65.00', currency: 'BRL' },
      calculatedBalance: { amount: '70.00', currency: 'BRL' },
      difference: { amount: '-5.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
    });
    const [row] = (await rawSql(orm, 'select balance from wallet where id = ?', [wallet.id])) as { balance: string }[];
    expect(row!.balance).toBe('65.00');
  });

  test('a wallet opened with zero balance has no entries and is consistent', async () => {
    const wallet = await newWallet(useCases.createWallet, '0.00');

    expect(json(await reconcile.execute(wallet.id))).toMatchObject({
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
  });

  test('returns null for an unknown wallet', async () => {
    expect(await reconcile.execute(randomUUID())).toBeNull();
  });

  test('reconciling while bets are being processed never reports a false divergence', async () => {
    const wallet = await newWallet(useCases.createWallet, '1000.00');

    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => useCases.processTransaction.execute(betFor(wallet, '1.00'))),
      ...Array.from({ length: 20 }, () => reconcile.execute(wallet.id)),
    ]);

    const reconciliations = results.slice(20) as Awaited<ReturnType<ReconcileWalletUseCase['execute']>>[];
    expect(reconciliations.every((result) => result?.consistent)).toBe(true);
    expect(json(await reconcile.execute(wallet.id))).toMatchObject({
      storedBalance: { amount: '980.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 21,
    });
  });
});
