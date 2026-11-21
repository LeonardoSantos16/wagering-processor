import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import { Money } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const NOW = new Date('2026-11-19T12:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function entryProps(overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: NOW,
    ...overrides,
  };
}

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    test('creates a balanced debit entry', () => {
      const entry = WalletLedgerEntry.create(entryProps());

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.money.toJSON().amount).toBe('25.00');
      expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
      expect(entry.isBalanced()).toBe(true);
    });

    test('creates a balanced credit entry', () => {
      const entry = WalletLedgerEntry.create(
        entryProps({ direction: LedgerDirection.Credit, balanceAfter: brl('125.00') }),
      );

      expect(entry.isBalanced()).toBe(true);
    });

    test.each([
      ['debit with wrong balanceAfter', { balanceAfter: brl('80.00') }],
      [
        'credit with debit arithmetic',
        { direction: LedgerDirection.Credit, balanceAfter: brl('75.00') },
      ],
      ['zero amount', { money: brl('0.00'), balanceAfter: brl('100.00') }],
      [
        'negative balanceAfter',
        { balanceBefore: brl('10.00'), balanceAfter: brl('10.00').subtract(brl('25.00')) },
      ],
      [
        'mixed currencies',
        {
          money: Money.from({ amount: '25.00', currency: 'USD' }),
          balanceBefore: Money.from({ amount: '100.00', currency: 'USD' }),
        },
      ],
    ])('rejects %s', (_, overrides) => {
      expect(() => WalletLedgerEntry.create(entryProps(overrides))).toThrow(
        InvariantViolationError,
      );
    });
  });

  describe('rehydrate', () => {
    test('rebuilds an entry from persisted state', () => {
      const state = entryProps();

      const entry = WalletLedgerEntry.rehydrate(state);

      expect(entry.id).toBe('entry-1');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-1');
      expect(entry.createdAt).toEqual(NOW);
      expect(entry.isBalanced()).toBe(true);
    });
  });
});
