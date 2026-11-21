import type { FailureCode } from '../errors/failure-code';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import type { MoneyProps } from '../money/money';
import type { WagerTransaction } from '../wagering/wager-transaction';
import type { WagerTransactionKind } from '../wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../wagering/wager-transaction-status';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

export interface WagerTransactionEventData {
  transactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  providerId?: string;
  externalTransactionId?: string;
  roundId?: string;
  gameId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  balanceAfter: MoneyProps;
  referenceTransactionId?: string;
  /** ISO-8601 */
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balanceAfter?: MoneyProps;
  /** ISO-8601 */
  rejectedAt: string;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        balanceAfter: required(tx.balanceAfter, 'balanceAfter').toJSON(),
        ...(tx.referenceTransactionId !== undefined && {
          referenceTransactionId: tx.referenceTransactionId,
        }),
        processedAt: required(tx.processedAt, 'processedAt').toISOString(),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        failureCode: required(tx.failureCode, 'failureCode'),
        ...(tx.balanceAfter !== undefined && { balanceAfter: tx.balanceAfter.toJSON() }),
        rejectedAt: required(tx.resolvedAt, 'resolvedAt').toISOString(),
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        referenceExternalTransactionId: required(
          tx.referenceExternalTransactionId,
          'referenceExternalTransactionId',
        ),
      },
    });
  }
}

function baseData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.provider && {
      providerId: tx.provider.providerId,
      externalTransactionId: tx.provider.externalTransactionId,
      roundId: tx.provider.roundId,
      gameId: tx.provider.gameId,
    }),
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) {
    throw new InvariantViolationError(
      `event requires a ${expected} transaction, got ${tx.status}`,
    );
  }
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new InvariantViolationError(`transaction is missing ${field}`);
  }
  return value;
}
