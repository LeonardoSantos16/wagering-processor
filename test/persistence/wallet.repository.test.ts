import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/wallet/mikro-orm-wallet.repository';
import { Wallet } from '../../src/domain/wallet/wallet';
import { Money } from '../../src/domain/money/money';

describe('MikroOrmWalletRepository', () => {
  let orm: MikroORM;

  const repositoryInNewContext = () => new MikroOrmWalletRepository(orm.em.fork());

  const openWallet = (amount: string) =>
    Wallet.open({
      id: randomUUID(),
      playerId: `player-${randomUUID()}`,
      initialBalance: Money.from({ amount, currency: 'BRL' }),
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
      now: new Date('2026-01-01T10:00:00.000Z'),
    }).wallet;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  test('persists a new wallet and loads it back in another context', async () => {
    const wallet = openWallet('100.00');
    const em = orm.em.fork();
    await new MikroOrmWalletRepository(em).save(wallet);
    await em.flush();

    const loaded = await repositoryInNewContext().findById(wallet.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(wallet.id);
    expect(loaded!.playerId).toBe(wallet.playerId);
    expect(loaded!.currency).toBe('BRL');
    expect(loaded!.balance.equals(Money.from({ amount: '100.00', currency: 'BRL' }))).toBe(true);
    expect(loaded!.version).toBe(1);
    expect(loaded!.createdAt.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    expect(loaded!.updatedAt.toISOString()).toBe('2026-01-01T10:00:00.000Z');
  });

  test('returns null for an unknown wallet', async () => {
    expect(await repositoryInNewContext().findById(randomUUID())).toBeNull();
  });

  test('persists balance, version and updatedAt after a domain movement', async () => {
    const wallet = openWallet('100.00');
    const setup = orm.em.fork();
    await new MikroOrmWalletRepository(setup).save(wallet);
    await setup.flush();

    const em = orm.em.fork();
    const repository = new MikroOrmWalletRepository(em);
    const loaded = (await repository.findById(wallet.id))!;
    loaded.debit({
      amount: Money.from({ amount: '25.00', currency: 'BRL' }),
      transactionId: randomUUID(),
      entryId: randomUUID(),
      now: new Date('2026-01-01T11:00:00.000Z'),
    });
    await repository.save(loaded);
    await em.flush();

    const reloaded = (await repositoryInNewContext().findById(wallet.id))!;
    expect(reloaded.balance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(reloaded.version).toBe(2);
    expect(reloaded.updatedAt.toISOString()).toBe('2026-01-01T11:00:00.000Z');
  });

  test('round-trips the maximum supported amount without precision loss', async () => {
    const wallet = openWallet('999999999999999999.99');
    const em = orm.em.fork();
    await new MikroOrmWalletRepository(em).save(wallet);
    await em.flush();

    const loaded = (await repositoryInNewContext().findById(wallet.id))!;
    expect(loaded.balance.toJSON()).toEqual({ amount: '999999999999999999.99', currency: 'BRL' });
  });
});
