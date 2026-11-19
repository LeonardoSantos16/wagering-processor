import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../errors/failure-code';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import { Money } from '../money/money';
import { WagerTransaction } from '../wagering/wager-transaction';
import { WagerTransactionKind } from '../wagering/wager-transaction-kind';
import type { EventContext } from './integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from './wager-transaction-events';

const NOW = new Date('2026-11-19T15:00:00.000Z');
const LATER = new Date('2026-11-19T15:00:01.000Z');
const CTX: EventContext = { eventId: 'event-1', correlationId: 'correlation-1', occurredAt: LATER };

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function transaction(kind = WagerTransactionKind.Bet, referenceExternalTransactionId?: string) {
  return WagerTransaction.create({
    id: 'tx-1',
    provider: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
    },
    walletId: 'wallet-1',
    playerId: 'player-1',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId,
    now: NOW,
  });
}

const PROVIDER_DATA = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
};

describe('WagerTransactionProcessed', () => {
  test('carries the applied result, with the transaction as aggregate', () => {
    const tx = transaction(WagerTransactionKind.Refund, 'transaction-100');
    tx.markProcessed({ referenceTransactionId: 'tx-bet', balanceAfter: brl('1000.00'), at: LATER });

    const json = WagerTransactionProcessed.from(tx, CTX).toJSON() as unknown;

    expect(json).toEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'tx-1',
      correlationId: 'correlation-1',
      occurredAt: '2026-11-19T15:00:01.000Z',
      version: 1,
      data: {
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        balanceAfter: { amount: '1000.00', currency: 'BRL' },
        referenceTransactionId: 'tx-bet',
        processedAt: '2026-11-19T15:00:01.000Z',
        ...PROVIDER_DATA,
      },
    });
  });

  test('is also emitted for LOSS', () => {
    const tx = transaction(WagerTransactionKind.Loss);
    tx.markProcessed({ balanceAfter: brl('975.00'), at: LATER });

    expect(WagerTransactionProcessed.from(tx, CTX).data.kind).toBe(WagerTransactionKind.Loss);
  });

  test('OPENING is emitted without provider data', () => {
    const opening = WagerTransaction.opening({
      id: 'tx-opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      now: NOW,
    });

    const data = WagerTransactionProcessed.from(opening, CTX).toJSON().data;

    expect(data.kind).toBe(WagerTransactionKind.Opening);
    expect('providerId' in data).toBe(false);
    expect('externalTransactionId' in data).toBe(false);
    expect('referenceTransactionId' in data).toBe(false);
  });

  test('requires a PROCESSED transaction', () => {
    expect(() => WagerTransactionProcessed.from(transaction(), CTX)).toThrow(
      InvariantViolationError,
    );
  });
});

describe('WagerTransactionRejected', () => {
  test('carries the failure code and the observed balance', () => {
    const tx = transaction();
    tx.reject({ code: FailureCode.InsufficientFunds, balanceAfter: brl('20.00'), at: LATER });

    const json = WagerTransactionRejected.from(tx, CTX).toJSON() as unknown;

    expect(json).toEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionRejected',
      aggregateId: 'tx-1',
      correlationId: 'correlation-1',
      occurredAt: '2026-11-19T15:00:01.000Z',
      version: 1,
      data: {
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        failureCode: 'INSUFFICIENT_FUNDS',
        balanceAfter: { amount: '20.00', currency: 'BRL' },
        rejectedAt: '2026-11-19T15:00:01.000Z',
        ...PROVIDER_DATA,
      },
    });
  });

  test('requires a REJECTED transaction', () => {
    expect(() => WagerTransactionRejected.from(transaction(), CTX)).toThrow(InvariantViolationError);
  });
});

describe('WagerTransactionPendingReference', () => {
  test('carries the missing reference', () => {
    const tx = transaction(WagerTransactionKind.Rollback, 'transaction-100');
    tx.markPendingReference(LATER);

    const json = WagerTransactionPendingReference.from(tx, CTX).toJSON() as unknown;

    expect(json).toEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionPendingReference',
      aggregateId: 'tx-1',
      correlationId: 'correlation-1',
      occurredAt: '2026-11-19T15:00:01.000Z',
      version: 1,
      data: {
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        kind: 'ROLLBACK',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: 'transaction-100',
        ...PROVIDER_DATA,
      },
    });
  });

  test('requires a PENDING_REFERENCE transaction', () => {
    expect(() =>
      WagerTransactionPendingReference.from(transaction(WagerTransactionKind.Refund, 'x'), CTX),
    ).toThrow(InvariantViolationError);
  });
});
