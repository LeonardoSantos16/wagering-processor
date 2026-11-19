import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import { Money } from '../money/money';
import { Wallet } from '../wallet/wallet';
import type { EventContext } from './integration-event';
import { WalletBalanceChanged } from './wallet-balance-changed';

const OCCURRED_AT = new Date('2026-11-19T15:00:00.000Z');

const CTX: EventContext = {
  eventId: 'event-1',
  correlationId: 'correlation-1',
  causationId: 'msg-123',
  occurredAt: OCCURRED_AT,
};

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function walletAfterBet() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('1000.00'),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    now: OCCURRED_AT,
  });
  const entry = wallet.debit({
    amount: brl('25.00'),
    transactionId: 'tx-1',
    entryId: 'entry-1',
    now: OCCURRED_AT,
  });
  return { wallet, entry };
}

describe('WalletBalanceChanged', () => {
  test('serializes the envelope with type and version from the class', () => {
    const { wallet, entry } = walletAfterBet();

    const event = WalletBalanceChanged.from(wallet, entry, CTX);

    expect(event.toJSON() as unknown).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'msg-123',
      occurredAt: '2026-11-19T15:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '1000.00', currency: 'BRL' },
        balanceAfter: { amount: '975.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('the serialized payload is plain JSON (no Money instances)', () => {
    const { wallet, entry } = walletAfterBet();

    const json = WalletBalanceChanged.from(wallet, entry, CTX).toJSON();

    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('omits causationId when absent', () => {
    const { wallet, entry } = walletAfterBet();

    const json = WalletBalanceChanged.from(wallet, entry, { ...CTX, causationId: undefined }).toJSON();

    expect('causationId' in json).toBe(false);
  });

  test('data is immutable', () => {
    const { wallet, entry } = walletAfterBet();
    const event = WalletBalanceChanged.from(wallet, entry, CTX);

    expect(Object.isFrozen(event.data)).toBe(true);
  });

  test('rejects an entry from another wallet', () => {
    const { entry } = walletAfterBet();
    const { wallet: other } = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-2',
      initialBalance: brl('975.00'),
      openingTransactionId: 'tx-opening-2',
      openingEntryId: 'entry-opening-2',
      now: OCCURRED_AT,
    });

    expect(() => WalletBalanceChanged.from(other, entry, CTX)).toThrow(InvariantViolationError);
  });

  test('rejects an entry that is not the latest wallet movement', () => {
    const { wallet, entry } = walletAfterBet();
    wallet.debit({ amount: brl('5.00'), transactionId: 'tx-2', entryId: 'entry-2', now: OCCURRED_AT });

    expect(() => WalletBalanceChanged.from(wallet, entry, CTX)).toThrow(InvariantViolationError);
  });
});
