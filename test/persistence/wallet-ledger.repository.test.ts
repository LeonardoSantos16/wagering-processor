import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
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
});
