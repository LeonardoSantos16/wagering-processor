import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import type { LedgerPosition } from '../../src/application/ports/wallet-ledger.repository';
import { MikroOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/ledger/mikro-orm-wallet-ledger.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/wager-transaction/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/wallet/mikro-orm-wallet.repository';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { Wallet } from '../../src/domain/wallet/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, second));

describe('MikroOrmWalletLedgerRepository', () => {
  let orm: MikroORM;

  const providerTransaction = (wallet: Wallet, kind: WagerTransactionKind, amount: string, second: number) => {
    const externalTransactionId = `tx-${randomUUID()}`;
    return WagerTransaction.create({
      id: randomUUID(),
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
      now: at(second),
    });
  };

  const walletWithHistory = async () => {
    const openingTransactionId = randomUUID();
    const { wallet, openingEntry } = Wallet.open({
      id: randomUUID(),
      playerId: `player-${randomUUID()}`,
      initialBalance: brl('100.00'),
      openingTransactionId,
      openingEntryId: randomUUID(),
      now: at(0),
    });
    const opening = WagerTransaction.opening({
      id: openingTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl('100.00'),
      now: at(0),
    });

    const bet = providerTransaction(wallet, WagerTransactionKind.Bet, '25.00', 1);
    const betEntry = wallet.debit({ amount: bet.money, transactionId: bet.id, entryId: randomUUID(), now: at(1) });
    bet.markProcessed({ balanceAfter: wallet.balance, at: at(1) });

    const win = providerTransaction(wallet, WagerTransactionKind.Win, '10.00', 2);
    const winEntry = wallet.credit({ amount: win.money, transactionId: win.id, entryId: randomUUID(), now: at(2) });
    win.markProcessed({ balanceAfter: wallet.balance, at: at(2) });

    await orm.em.fork().transactional(async (em) => {
      await new MikroOrmWalletRepository(em).save(wallet);
      const transactions = new MikroOrmWagerTransactionRepository(em);
      const ledger = new MikroOrmWalletLedgerRepository(em);
      for (const transaction of [opening, bet, win]) {
        await transactions.save(transaction);
      }
      for (const entry of [openingEntry!, betEntry, winEntry]) {
        await ledger.append(entry);
      }
    });

    return { wallet, entries: [openingEntry!, betEntry, winEntry] };
  };

  const replay = (entries: WalletLedgerEntry[], currency: string) =>
    entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit
          ? balance.add(entry.money)
          : balance.subtract(entry.money),
      Money.zero(currency),
    );

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  test('returns the wallet history in order, with every field preserved', async () => {
    const { wallet, entries } = await walletWithHistory();

    const loaded = await new MikroOrmWalletLedgerRepository(orm.em.fork()).findByWallet(wallet.id);

    expect(loaded.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    const [, bet] = loaded;
    expect(bet!.walletId).toBe(wallet.id);
    expect(bet!.transactionId).toBe(entries[1]!.transactionId);
    expect(bet!.direction).toBe(LedgerDirection.Debit);
    expect(bet!.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(bet!.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(bet!.balanceAfter.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(bet!.createdAt).toEqual(at(1));
    expect(loaded.every((entry) => entry.isBalanced())).toBe(true);
  });

  test('the persisted balance equals the balance replayed from the ledger', async () => {
    const { wallet } = await walletWithHistory();
    const em = orm.em.fork();

    const stored = (await new MikroOrmWalletRepository(em).findById(wallet.id))!;
    const entries = await new MikroOrmWalletLedgerRepository(em).findByWallet(wallet.id);

    expect(stored.balance.toJSON()).toEqual({ amount: '85.00', currency: 'BRL' });
    expect(replay(entries, stored.currency).equals(stored.balance)).toBe(true);
  });

  test('returns an empty history for a wallet without entries', async () => {
    expect(await new MikroOrmWalletLedgerRepository(orm.em.fork()).findByWallet(randomUUID())).toEqual([]);
  });

  describe('findPage', () => {
    const persist = (wallet: Wallet, transactions: WagerTransaction[], entries: WalletLedgerEntry[]) =>
      orm.em.fork().transactional(async (em) => {
        const wallets = new MikroOrmWalletRepository(em);
        await wallets.findById(wallet.id);
        await wallets.save(wallet);
        const transactionRepository = new MikroOrmWagerTransactionRepository(em);
        const ledger = new MikroOrmWalletLedgerRepository(em);
        for (const transaction of transactions) {
          await transactionRepository.save(transaction);
        }
        for (const entry of entries) {
          await ledger.append(entry);
        }
      });

    const credit = (wallet: Wallet, amount: string, second: number) => {
      const win = providerTransaction(wallet, WagerTransactionKind.Win, amount, second);
      const entry = wallet.credit({ amount: win.money, transactionId: win.id, entryId: randomUUID(), now: at(second) });
      win.markProcessed({ balanceAfter: wallet.balance, at: at(second) });
      return { transaction: win, entry };
    };

    const walletWithTies = async () => {
      const { wallet, entries } = await walletWithHistory();
      const tied = [1, 2, 3, 4].map(() => credit(wallet, '1.00', 1));
      await persist(
        wallet,
        tied.map((movement) => movement.transaction),
        tied.map((movement) => movement.entry),
      );
      const all = [...entries, ...tied.map((movement) => movement.entry)];
      const newestFirst = all.toSorted(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
      return { wallet, newestFirst };
    };

    const readAllPages = async (walletId: string, limit: number) => {
      const repository = new MikroOrmWalletLedgerRepository(orm.em.fork());
      const pages: string[][] = [];
      let after: LedgerPosition | undefined;
      for (;;) {
        const page = await repository.findPage(walletId, after, limit);
        if (page.length === 0) {
          return pages;
        }
        pages.push(page.map((entry) => entry.id));
        const last = page.at(-1)!;
        after = { createdAt: last.createdAt, id: last.id };
      }
    };

    test('pages newest first, breaking createdAt ties by id, without gaps or repeats', async () => {
      const { wallet, newestFirst } = await walletWithTies();

      const pages = await readAllPages(wallet.id, 2);

      expect(pages.map((page) => page.length)).toEqual([2, 2, 2, 1]);
      expect(pages.flat()).toEqual(newestFirst.map((entry) => entry.id));
    });

    test('a cursor in the middle of a createdAt tie continues with the remaining tied entries', async () => {
      const { wallet, newestFirst } = await walletWithTies();
      const repository = new MikroOrmWalletLedgerRepository(orm.em.fork());
      const middle = newestFirst[3]!;

      const page = await repository.findPage(wallet.id, { createdAt: middle.createdAt, id: middle.id }, 10);

      expect(page.map((entry) => entry.id)).toEqual(newestFirst.slice(4).map((entry) => entry.id));
    });

    test('entries appended between pages do not shift the following pages', async () => {
      const { wallet, newestFirst } = await walletWithTies();
      const repository = new MikroOrmWalletLedgerRepository(orm.em.fork());
      const first = await repository.findPage(wallet.id, undefined, 3);
      const last = first.at(-1)!;

      const later = credit(wallet, '5.00', 30);
      await persist(wallet, [later.transaction], [later.entry]);
      const rest = await new MikroOrmWalletLedgerRepository(orm.em.fork()).findPage(
        wallet.id,
        { createdAt: last.createdAt, id: last.id },
        100,
      );

      expect([...first, ...rest].map((entry) => entry.id)).toEqual(newestFirst.map((entry) => entry.id));
    });

    test('does not return entries of other wallets', async () => {
      const { wallet, entries } = await walletWithHistory();
      await walletWithHistory();

      const page = await new MikroOrmWalletLedgerRepository(orm.em.fork()).findPage(wallet.id, undefined, 100);

      expect(page.map((entry) => entry.id).toSorted()).toEqual(entries.map((entry) => entry.id).toSorted());
    });
  });
});
