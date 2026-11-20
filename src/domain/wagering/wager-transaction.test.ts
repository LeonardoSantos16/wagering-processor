import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../errors/failure-code';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { InvalidMoneyError } from '../money/money.errors';
import { computePayloadHash } from './payload-hash';
import { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';
import type { CreateWagerTransactionProps } from './wager-transaction.types';
import {
  InvalidKindError,
  InvalidTransactionStateError,
  MissingReferenceError,
} from './wager-transaction.errors';

const NOW = new Date('2026-11-19T12:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
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
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    now: NOW,
    ...overrides,
  };
}

function tx(kind: WagerTransactionKind, overrides: Partial<CreateWagerTransactionProps> = {}) {
  const needsReference =
    kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  return WagerTransaction.create(
    props({
      kind,
      referenceExternalTransactionId: needsReference ? 'transaction-100' : undefined,
      ...overrides,
    }),
  );
}

describe('WagerTransaction', () => {
  describe('create', () => {
    test('is born PENDING with the given data', () => {
      const tx = WagerTransaction.create(props());

      expect(tx.id).toBe('tx-1');
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.provider?.providerId).toBe('provider-a');
      expect(tx.provider?.idempotencyKey).toBe('provider-a:transaction-123');
      expect(tx.walletId).toBe('wallet-1');
      expect(tx.playerId).toBe('player-1');
      expect(tx.kind).toBe(WagerTransactionKind.Bet);
      expect(tx.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(tx.createdAt).toEqual(NOW);
      expect(tx.referenceTransactionId).toBeUndefined();
      expect(tx.failureCode).toBeUndefined();
      expect(tx.processedAt).toBeUndefined();
      expect(tx.resolvedAt).toBeUndefined();
      expect(tx.balanceAfter).toBeUndefined();
    });

    test('computes the payload hash from its own business fields', () => {
      const tx = WagerTransaction.create(
        props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'transaction-100' }),
      );

      expect(tx.payloadHash).toBe(
        computePayloadHash({
          providerId: 'provider-a',
          externalTransactionId: 'transaction-123',
          playerId: 'player-1',
          walletId: 'wallet-1',
          roundId: 'round-987',
          gameId: 'fortune-chimp',
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: 'transaction-100',
        }),
      );
    });

    test('accepts a WIN with an optional reference', () => {
      const tx = WagerTransaction.create(
        props({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'transaction-100' }),
      );

      expect(tx.referenceExternalTransactionId).toBe('transaction-100');
    });

    test('rejects OPENING submitted from outside', () => {
      const error = captureError(() =>
        WagerTransaction.create(props({ kind: WagerTransactionKind.Opening })),
      );

      expect(error).toBeInstanceOf(InvalidKindError);
      expect((error as InvalidKindError).code).toBe(FailureCode.InvalidKind);
    });

    test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
      'rejects %s without a reference',
      (kind) => {
        const error = captureError(() => WagerTransaction.create(props({ kind })));

        expect(error).toBeInstanceOf(MissingReferenceError);
        expect((error as MissingReferenceError).code).toBe(FailureCode.MissingReference);
      },
    );

    test('rejects a zero amount', () => {
      const error = captureError(() => WagerTransaction.create(props({ money: brl('0.00') })));

      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect((error as InvalidMoneyError).code).toBe(FailureCode.InvalidMoney);
    });
  });

  describe('queries', () => {
    test('affectsBalance is false only for LOSS', () => {
      expect(tx(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
      for (const kind of [
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback,
      ]) {
        expect(tx(kind).affectsBalance()).toBe(true);
      }
    });

    test('requiresReference is true only for REFUND and ROLLBACK', () => {
      expect(tx(WagerTransactionKind.Refund).requiresReference()).toBe(true);
      expect(tx(WagerTransactionKind.Rollback).requiresReference()).toBe(true);
      expect(tx(WagerTransactionKind.Bet).requiresReference()).toBe(false);
      expect(tx(WagerTransactionKind.Win).requiresReference()).toBe(false);
      expect(tx(WagerTransactionKind.Loss).requiresReference()).toBe(false);
    });

    test('matchesPayload compares the payload hash', () => {
      const transaction = tx(WagerTransactionKind.Bet);
      const sameRequest = tx(WagerTransactionKind.Bet);
      const differentRequest = WagerTransaction.create(props({ money: brl('26.00') }));

      expect(transaction.matchesPayload(sameRequest.payloadHash!)).toBe(true);
      expect(transaction.matchesPayload(differentRequest.payloadHash!)).toBe(false);
    });

    test('a new transaction is not terminal', () => {
      expect(tx(WagerTransactionKind.Bet).isTerminal()).toBe(false);
    });
  });

  describe('ledgerDirectionFor', () => {
    test.each([
      [WagerTransactionKind.Bet, LedgerDirection.Debit],
      [WagerTransactionKind.Win, LedgerDirection.Credit],
      [WagerTransactionKind.Refund, LedgerDirection.Credit],
    ])('%s -> %s', (kind, direction) => {
      expect(tx(kind).ledgerDirectionFor()).toBe(direction);
    });

    test('OPENING -> CREDIT', () => {
      const opening = WagerTransaction.opening({
        id: 'tx-opening',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        now: NOW,
      });

      expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    test.each([
      [WagerTransactionKind.Bet, LedgerDirection.Credit],
      [WagerTransactionKind.Win, LedgerDirection.Debit],
      [WagerTransactionKind.Refund, LedgerDirection.Debit],
    ])('ROLLBACK of %s -> %s (inverse of the reference)', (referenceKind, direction) => {
      const rollback = tx(WagerTransactionKind.Rollback);

      expect(rollback.ledgerDirectionFor(tx(referenceKind))).toBe(direction);
    });

    test('ROLLBACK without the reference is an invariant violation', () => {
      expect(() => tx(WagerTransactionKind.Rollback).ledgerDirectionFor()).toThrow(
        InvariantViolationError,
      );
    });

    test('LOSS has no ledger direction', () => {
      expect(() => tx(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(
        InvariantViolationError,
      );
    });
  });

  describe('transitions', () => {
    const LATER = new Date('2026-11-19T12:01:00.000Z');
    const RETRY_AT = new Date('2026-11-19T12:02:00.000Z');
    const NEXT_RETRY_AT = new Date('2026-11-19T12:06:00.000Z');

    function pendingReference(): WagerTransaction {
      const transaction = tx(WagerTransactionKind.Refund);
      transaction.markPendingReference(RETRY_AT);
      return transaction;
    }

    test('PENDING -> PROCESSED records the result', () => {
      const transaction = tx(WagerTransactionKind.Bet);

      transaction.markProcessed({ balanceAfter: brl('975.00'), at: LATER });

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.isTerminal()).toBe(true);
      expect(transaction.processedAt).toEqual(LATER);
      expect(transaction.resolvedAt).toEqual(LATER);
      expect(transaction.balanceAfter?.toJSON().amount).toBe('975.00');
      expect(transaction.referenceTransactionId).toBeUndefined();
      expect(transaction.failureCode).toBeUndefined();
    });

    test('PROCESSED with a reference records the internal reference id', () => {
      const transaction = tx(WagerTransactionKind.Refund);

      transaction.markProcessed({
        referenceTransactionId: 'tx-bet',
        balanceAfter: brl('1000.00'),
        at: LATER,
      });

      expect(transaction.referenceTransactionId).toBe('tx-bet');
    });

    test('markProcessed requires the reference id when the transaction has a reference', () => {
      expect(() =>
        tx(WagerTransactionKind.Refund).markProcessed({ balanceAfter: brl('1.00'), at: LATER }),
      ).toThrow(InvariantViolationError);
    });

    test('markProcessed rejects a reference id when the transaction has no reference', () => {
      expect(() =>
        tx(WagerTransactionKind.Bet).markProcessed({
          referenceTransactionId: 'tx-other',
          balanceAfter: brl('1.00'),
          at: LATER,
        }),
      ).toThrow(InvariantViolationError);
    });

    test('PENDING -> REJECTED records the failure code and the observed balance', () => {
      const transaction = tx(WagerTransactionKind.Bet);

      transaction.reject({
        code: FailureCode.InsufficientFunds,
        balanceAfter: brl('20.00'),
        at: LATER,
      });

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.isTerminal()).toBe(true);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(transaction.balanceAfter?.toJSON().amount).toBe('20.00');
      expect(transaction.resolvedAt).toEqual(LATER);
      expect(transaction.processedAt).toBeUndefined();
    });

    test('CURRENCY_MISMATCH is rejected without a balance', () => {
      const transaction = tx(WagerTransactionKind.Bet);

      transaction.reject({ code: FailureCode.CurrencyMismatch, at: LATER });

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(transaction.balanceAfter).toBeUndefined();
    });

    test('CURRENCY_MISMATCH cannot record a balance', () => {
      expect(() =>
        tx(WagerTransactionKind.Bet).reject({
          code: FailureCode.CurrencyMismatch,
          balanceAfter: Money.from({ amount: '10.00', currency: 'USD' }),
          at: LATER,
        }),
      ).toThrow(InvariantViolationError);
    });

    test('any other rejection requires the observed balance', () => {
      expect(() =>
        tx(WagerTransactionKind.Bet).reject({ code: FailureCode.InsufficientFunds, at: LATER }),
      ).toThrow(InvariantViolationError);
    });

    test('reject requires the balance in the transaction currency', () => {
      expect(() =>
        tx(WagerTransactionKind.Bet).reject({
          code: FailureCode.InsufficientFunds,
          balanceAfter: Money.from({ amount: '10.00', currency: 'USD' }),
          at: LATER,
        }),
      ).toThrow(InvariantViolationError);
    });

    test('markProcessed requires the balance in the transaction currency', () => {
      expect(() =>
        tx(WagerTransactionKind.Bet).markProcessed({
          balanceAfter: Money.from({ amount: '10.00', currency: 'USD' }),
          at: LATER,
        }),
      ).toThrow(InvariantViolationError);
    });

    test('PENDING -> FAILED records the failure code without a balance', () => {
      const transaction = tx(WagerTransactionKind.Bet);

      transaction.fail({ code: FailureCode.ProcessingFailed, at: LATER });

      expect(transaction.status).toBe(WagerTransactionStatus.Failed);
      expect(transaction.isTerminal()).toBe(true);
      expect(transaction.failureCode).toBe(FailureCode.ProcessingFailed);
      expect(transaction.resolvedAt).toEqual(LATER);
      expect(transaction.balanceAfter).toBeUndefined();
      expect(transaction.processedAt).toBeUndefined();
    });

    test('PENDING -> PENDING_REFERENCE schedules the first retry', () => {
      const transaction = pendingReference();

      expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
      expect(transaction.isTerminal()).toBe(false);
      expect(transaction.referenceAttempts).toBe(0);
      expect(transaction.nextReferenceAttemptAt).toEqual(RETRY_AT);
    });

    test('a WIN with a reference can wait for it', () => {
      const win = tx(WagerTransactionKind.Win, { referenceExternalTransactionId: 'transaction-100' });

      win.markPendingReference(RETRY_AT);

      expect(win.status).toBe(WagerTransactionStatus.PendingReference);
    });

    test('a transaction without a reference cannot wait for one', () => {
      expect(() => tx(WagerTransactionKind.Bet).markPendingReference(RETRY_AT)).toThrow(
        InvariantViolationError,
      );
    });

    test('scheduleReferenceRetry counts the attempt and keeps the status', () => {
      const transaction = pendingReference();

      transaction.scheduleReferenceRetry(NEXT_RETRY_AT);

      expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
      expect(transaction.referenceAttempts).toBe(1);
      expect(transaction.nextReferenceAttemptAt).toEqual(NEXT_RETRY_AT);
    });

    test.each([
      ['PROCESSED', (t: WagerTransaction) =>
        t.markProcessed({ referenceTransactionId: 'tx-bet', balanceAfter: brl('1.00'), at: LATER })],
      ['REJECTED', (t: WagerTransaction) =>
        t.reject({ code: FailureCode.ReferenceNotFound, balanceAfter: brl('1.00'), at: LATER })],
      ['FAILED', (t: WagerTransaction) => t.fail({ code: FailureCode.ProcessingFailed, at: LATER })],
    ])('PENDING_REFERENCE -> %s goes straight to the final state', (status, resolve) => {
      const transaction = pendingReference();

      resolve(transaction);

      expect(transaction.status).toBe(status as WagerTransactionStatus);
      expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    });

    test('markPendingReference twice is an invalid transition', () => {
      expect(() => pendingReference().markPendingReference(NEXT_RETRY_AT)).toThrow(
        InvalidTransactionStateError,
      );
    });

    test('scheduleReferenceRetry outside PENDING_REFERENCE is an invalid transition', () => {
      expect(() => tx(WagerTransactionKind.Refund).scheduleReferenceRetry(NEXT_RETRY_AT)).toThrow(
        InvalidTransactionStateError,
      );
    });

    const terminalStates: Array<[string, () => WagerTransaction]> = [
      ['PROCESSED', () => {
        const t = tx(WagerTransactionKind.Bet);
        t.markProcessed({ balanceAfter: brl('1.00'), at: LATER });
        return t;
      }],
      ['REJECTED', () => {
        const t = tx(WagerTransactionKind.Bet);
        t.reject({ code: FailureCode.InsufficientFunds, balanceAfter: brl('1.00'), at: LATER });
        return t;
      }],
      ['FAILED', () => {
        const t = tx(WagerTransactionKind.Bet);
        t.fail({ code: FailureCode.ProcessingFailed, at: LATER });
        return t;
      }],
    ];

    const actions: Array<[string, (t: WagerTransaction) => void]> = [
      ['markProcessed', (t) => t.markProcessed({ balanceAfter: brl('1.00'), at: LATER })],
      ['reject', (t) =>
        t.reject({ code: FailureCode.InsufficientFunds, balanceAfter: brl('1.00'), at: LATER })],
      ['fail', (t) => t.fail({ code: FailureCode.ProcessingFailed, at: LATER })],
      ['markPendingReference', (t) => t.markPendingReference(RETRY_AT)],
      ['scheduleReferenceRetry', (t) => t.scheduleReferenceRetry(RETRY_AT)],
    ];

    for (const [state, build] of terminalStates) {
      test.each(actions)(`${state} is terminal: %s throws InvalidTransactionStateError`, (_, act) => {
        const transaction = build();

        expect(() => act(transaction)).toThrow(InvalidTransactionStateError);
        expect(transaction.status).toBe(state as WagerTransactionStatus);
      });
    }

    test('OPENING is created terminal', () => {
      const opening = WagerTransaction.opening({
        id: 'tx-opening',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        now: NOW,
      });

      expect(() =>
        opening.reject({ code: FailureCode.InsufficientFunds, balanceAfter: brl('1.00'), at: LATER }),
      ).toThrow(InvalidTransactionStateError);
    });
  });

  describe('checkReference', () => {
    const AT = new Date('2026-11-19T12:01:00.000Z');

    /** A transaction from the provider, identified by its external id, already PROCESSED. */
    function processed(
      kind: WagerTransactionKind,
      externalTransactionId: string,
      overrides: Partial<CreateWagerTransactionProps> = {},
    ): WagerTransaction {
      const base = props();
      const transaction = WagerTransaction.create({
        ...base,
        id: `tx-${externalTransactionId}`,
        kind,
        provider: { ...base.provider, externalTransactionId, idempotencyKey: `provider-a:${externalTransactionId}` },
        referenceExternalTransactionId:
          kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
            ? 'transaction-000'
            : undefined,
        ...overrides,
      });
      transaction.markProcessed({
        referenceTransactionId: transaction.referenceExternalTransactionId ? 'tx-000' : undefined,
        balanceAfter: Money.from({ amount: '100.00', currency: transaction.money.currency }),
        at: AT,
      });
      return transaction;
    }

    /** A new transaction pointing to `transaction-100`. */
    function referencing(kind: WagerTransactionKind, amount = '25.00'): WagerTransaction {
      return tx(kind, { referenceExternalTransactionId: 'transaction-100', money: brl(amount) });
    }

    test.each([
      [WagerTransactionKind.Refund, WagerTransactionKind.Bet],
      [WagerTransactionKind.Rollback, WagerTransactionKind.Bet],
      [WagerTransactionKind.Rollback, WagerTransactionKind.Win],
      [WagerTransactionKind.Rollback, WagerTransactionKind.Refund],
      [WagerTransactionKind.Win, WagerTransactionKind.Bet],
    ])('%s of a PROCESSED %s from the same context is valid', (kind, referenceKind) => {
      const reference = processed(referenceKind, 'transaction-100');

      expect(referencing(kind).checkReference(reference)).toBeUndefined();
    });

    test.each([
      ['provider', { provider: { ...props().provider, providerId: 'provider-b' } }],
      ['player', { playerId: 'player-2' }],
      ['wallet', { walletId: 'wallet-2' }],
      ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
      ['round', { provider: { ...props().provider, roundId: 'round-988' } }],
    ])('a reference from another %s is REFERENCE_MISMATCH', (_, overrides) => {
      const base = props();
      const reference = processed(WagerTransactionKind.Bet, 'transaction-100', {
        ...overrides,
        provider: {
          ...base.provider,
          ...(overrides as Partial<CreateWagerTransactionProps>).provider,
          externalTransactionId: 'transaction-100',
          idempotencyKey: 'provider-a:transaction-100',
        },
      });

      expect(referencing(WagerTransactionKind.Refund).checkReference(reference)).toBe(
        FailureCode.ReferenceMismatch,
      );
    });

    test('the internal OPENING transaction cannot be referenced', () => {
      const opening = WagerTransaction.opening({
        id: 'tx-opening',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('25.00'),
        now: NOW,
      });

      expect(referencing(WagerTransactionKind.Rollback).checkReference(opening)).toBe(
        FailureCode.ReferenceMismatch,
      );
    });

    test.each([
      [WagerTransactionKind.Refund, WagerTransactionKind.Win],
      [WagerTransactionKind.Refund, WagerTransactionKind.Loss],
      [WagerTransactionKind.Refund, WagerTransactionKind.Refund],
      [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
      [WagerTransactionKind.Rollback, WagerTransactionKind.Loss],
      [WagerTransactionKind.Rollback, WagerTransactionKind.Rollback],
      [WagerTransactionKind.Win, WagerTransactionKind.Win],
      [WagerTransactionKind.Win, WagerTransactionKind.Refund],
    ])('%s referencing %s is INVALID_REFERENCE_KIND', (kind, referenceKind) => {
      const reference = processed(referenceKind, 'transaction-100');

      expect(referencing(kind).checkReference(reference)).toBe(FailureCode.InvalidReferenceKind);
    });

    test.each([
      ['PENDING', (_: WagerTransaction) => {}],
      ['REJECTED', (t: WagerTransaction) =>
        t.reject({ code: FailureCode.InsufficientFunds, balanceAfter: brl('1.00'), at: AT })],
      ['FAILED', (t: WagerTransaction) => t.fail({ code: FailureCode.ProcessingFailed, at: AT })],
    ])('a %s reference is REFERENCE_NOT_PROCESSED', (_, setState) => {
      const reference = tx(WagerTransactionKind.Bet, {
        id: 'tx-transaction-100',
        provider: {
          ...props().provider,
          externalTransactionId: 'transaction-100',
          idempotencyKey: 'provider-a:transaction-100',
        },
      });
      setState(reference);

      expect(referencing(WagerTransactionKind.Refund).checkReference(reference)).toBe(
        FailureCode.ReferenceNotProcessed,
      );
    });

    test('a reference still in PENDING_REFERENCE is REFERENCE_NOT_PROCESSED', () => {
      const pendingWin = tx(WagerTransactionKind.Win, {
        provider: {
          ...props().provider,
          externalTransactionId: 'transaction-100',
          idempotencyKey: 'provider-a:transaction-100',
        },
        referenceExternalTransactionId: 'transaction-050',
      });
      pendingWin.markPendingReference(AT);

      expect(referencing(WagerTransactionKind.Rollback).checkReference(pendingWin)).toBe(
        FailureCode.ReferenceNotProcessed,
      );
    });

    test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
      '%s with a different amount is AMOUNT_MISMATCH',
      (kind) => {
        const reference = processed(WagerTransactionKind.Bet, 'transaction-100');

        expect(referencing(kind, '26.00').checkReference(reference)).toBe(
          FailureCode.AmountMismatch,
        );
      },
    );

    test('a WIN may have a different amount than its BET', () => {
      const reference = processed(WagerTransactionKind.Bet, 'transaction-100');

      expect(referencing(WagerTransactionKind.Win, '50.00').checkReference(reference)).toBeUndefined();
    });

    test('checking a reference on a transaction without one is an invariant violation', () => {
      const reference = processed(WagerTransactionKind.Bet, 'transaction-100');

      expect(() => tx(WagerTransactionKind.Bet).checkReference(reference)).toThrow(
        InvariantViolationError,
      );
    });
  });

  describe('opening', () => {
    test('creates an internal transaction already PROCESSED, without provider data', () => {
      const tx = WagerTransaction.opening({
        id: 'tx-opening',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        now: NOW,
      });

      expect(tx.kind).toBe(WagerTransactionKind.Opening);
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.provider).toBeUndefined();
      expect(tx.money.toJSON().amount).toBe('1000.00');
      expect(tx.balanceAfter?.toJSON().amount).toBe('1000.00');
      expect(tx.processedAt).toEqual(NOW);
      expect(tx.resolvedAt).toEqual(NOW);
      expect(tx.createdAt).toEqual(NOW);
    });
  });
});
