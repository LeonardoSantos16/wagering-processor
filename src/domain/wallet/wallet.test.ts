import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../errors/failure-code';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { CurrencyMismatchError } from '../money/money.errors';
import { Wallet } from './wallet';
import { InsufficientFundsError } from './wallet.errors';

const CREATED_AT = new Date('2026-11-19T12:00:00.000Z');
const LATER = new Date('2026-11-19T12:05:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function usd(amount: string): Money {
  return Money.from({ amount, currency: 'USD' });
}

function movement(amount: string, transactionId = 'tx-1', entryId = 'entry-1') {
  return { amount: brl(amount), transactionId, entryId, now: LATER };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

function openWallet(initialBalance: string) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialBalance),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    now: CREATED_AT,
  });
}

describe('Wallet', () => {
  describe('open', () => {
    test('opens with the initial balance at version 1', () => {
      const { wallet } = openWallet('1000.00');

      expect(wallet.id).toBe('wallet-1');
      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(CREATED_AT);
      expect(wallet.updatedAt).toEqual(CREATED_AT);
    });

    test('a positive initial balance produces an opening credit entry', () => {
      const { openingEntry } = openWallet('1000.00');

      expect(openingEntry).toBeDefined();
      expect(openingEntry?.id).toBe('entry-opening');
      expect(openingEntry?.walletId).toBe('wallet-1');
      expect(openingEntry?.transactionId).toBe('tx-opening');
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.money.toJSON().amount).toBe('1000.00');
      expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
      expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
      expect(openingEntry?.createdAt).toEqual(CREATED_AT);
    });

    test('a zero initial balance produces no ledger entry', () => {
      const { wallet, openingEntry } = openWallet('0.00');

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeUndefined();
    });

    test('rejects a negative initial balance', () => {
      expect(() =>
        Wallet.open({
          id: 'wallet-1',
          playerId: 'player-1',
          initialBalance: brl('10.00').negate(),
          openingTransactionId: 'tx-opening',
          openingEntryId: 'entry-opening',
          now: CREATED_AT,
        }),
      ).toThrow(InvariantViolationError);
    });
  });

  describe('credit', () => {
    test('increases the balance, increments the version and returns a balanced entry', () => {
      const { wallet } = openWallet('100.00');

      const entry = wallet.credit(movement('50.00'));

      expect(wallet.balance.toJSON().amount).toBe('150.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(LATER);
      expect(entry.id).toBe('entry-1');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-1');
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.money.toJSON().amount).toBe('50.00');
      expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry.balanceAfter.toJSON().amount).toBe('150.00');
      expect(entry.createdAt).toEqual(LATER);
    });
  });

  describe('debit', () => {
    test('decreases the balance, increments the version and returns a balanced entry', () => {
      const { wallet } = openWallet('100.00');

      const entry = wallet.debit(movement('80.00'));

      expect(wallet.balance.toJSON().amount).toBe('20.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(LATER);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    });

    test('can debit the whole balance, leaving zero', () => {
      const { wallet } = openWallet('100.00');

      wallet.debit(movement('100.00'));

      expect(wallet.balance.isZero()).toBe(true);
    });

    test('throws InsufficientFundsError and leaves the wallet unchanged', () => {
      const { wallet } = openWallet('100.00');

      const error = captureError(() => wallet.debit(movement('100.01')));

      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect((error as InsufficientFundsError).code).toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(CREATED_AT);
    });

    test('scenario from the case: 100.00 balance, two 80.00 bets in sequence', () => {
      const { wallet } = openWallet('100.00');

      wallet.debit(movement('80.00'));

      expect(wallet.canDebit(brl('80.00'))).toBe(false);
      expect(() => wallet.debit(movement('80.00', 'tx-2', 'entry-2'))).toThrow(
        InsufficientFundsError,
      );
      expect(wallet.balance.toJSON().amount).toBe('20.00');
      expect(wallet.version).toBe(2);
    });
  });

  describe('canDebit', () => {
    test('is true when the balance covers the amount, including the exact balance', () => {
      const { wallet } = openWallet('100.00');

      expect(wallet.canDebit(brl('99.99'))).toBe(true);
      expect(wallet.canDebit(brl('100.00'))).toBe(true);
      expect(wallet.canDebit(brl('100.01'))).toBe(false);
    });
  });

  describe('movement guards', () => {
    test.each([
      ['credit', (wallet: Wallet) => wallet.credit(movement('0.00'))],
      ['debit', (wallet: Wallet) => wallet.debit(movement('0.00'))],
    ])('%s with a zero amount is an invariant violation', (_, operation) => {
      const { wallet } = openWallet('100.00');

      expect(() => operation(wallet)).toThrow(InvariantViolationError);
      expect(wallet.version).toBe(1);
    });

    test.each([
      ['credit', (wallet: Wallet) => wallet.credit({ ...movement('10.00'), amount: usd('10.00') })],
      ['debit', (wallet: Wallet) => wallet.debit({ ...movement('10.00'), amount: usd('10.00') })],
      ['canDebit', (wallet: Wallet) => wallet.canDebit(usd('10.00'))],
    ])('%s in another currency throws CurrencyMismatchError', (_, operation) => {
      const { wallet } = openWallet('100.00');

      const error = captureError(() => operation(wallet));

      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).code).toBe(FailureCode.CurrencyMismatch);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });
  });

  describe('rehydrate', () => {
    const state = {
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('975.00'),
      version: 7,
      createdAt: CREATED_AT,
      updatedAt: LATER,
    };

    test('rebuilds the persisted state as is', () => {
      const wallet = Wallet.rehydrate(state);

      expect(wallet.id).toBe('wallet-1');
      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toJSON().amount).toBe('975.00');
      expect(wallet.version).toBe(7);
      expect(wallet.createdAt).toEqual(CREATED_AT);
      expect(wallet.updatedAt).toEqual(LATER);
    });

    test('a rehydrated wallet keeps applying the same rules', () => {
      const wallet = Wallet.rehydrate(state);

      const entry = wallet.debit(movement('75.00'));

      expect(entry.balanceBefore.toJSON().amount).toBe('975.00');
      expect(wallet.balance.toJSON().amount).toBe('900.00');
      expect(wallet.version).toBe(8);
    });
  });

  describe('balance and ledger consistency', () => {
    test('the balance always equals the sum of the ledger entries', () => {
      const { wallet, openingEntry } = openWallet('100.00');
      const entries = [
        openingEntry!,
        wallet.debit(movement('30.00', 'tx-1', 'entry-1')),
        wallet.credit(movement('12.50', 'tx-2', 'entry-2')),
        wallet.debit(movement('82.50', 'tx-3', 'entry-3')),
      ];

      const rebuilt = entries.reduce(
        (balance, entry) =>
          entry.direction === LedgerDirection.Credit
            ? balance.add(entry.money)
            : balance.subtract(entry.money),
        Money.zero('BRL'),
      );

      expect(rebuilt.equals(wallet.balance)).toBe(true);
      expect(wallet.balance.toJSON().amount).toBe('0.00');
      expect(wallet.version).toBe(4);
      expect(entries.every((entry) => entry.isBalanced())).toBe(true);
    });
  });
});
