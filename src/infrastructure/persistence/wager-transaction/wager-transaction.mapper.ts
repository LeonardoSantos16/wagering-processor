import type { FailureCode } from '../../../domain/errors/failure-code';
import { InvariantViolationError } from '../../../domain/errors/invariant-violation.error';
import { Money } from '../../../domain/money/money';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import type { ProviderRef } from '../../../domain/wagering/wager-transaction.types';
import type { WagerTransactionRecord } from './wager-transaction.entity';

export type WagerTransactionRecordData = WagerTransactionRecord;

const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;
const orNull = <T>(value: T | undefined): T | null => value ?? null;

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecordData): WagerTransaction {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WagerTransaction.rehydrate({
      id: record.id,
      provider: providerFrom(record),
      walletId: record.walletId,
      playerId: record.playerId,
      kind: record.kind as WagerTransactionKind,
      money: money(record.amount),
      referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
      payloadHash: orUndefined(record.payloadHash),
      createdAt: record.createdAt,
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: orUndefined(record.referenceTransactionId),
      failureCode: orUndefined(record.failureCode) as FailureCode | undefined,
      processedAt: orUndefined(record.processedAt),
      resolvedAt: orUndefined(record.resolvedAt),
      balanceAfter: record.balanceAfter == null ? undefined : money(record.balanceAfter),
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: orUndefined(record.nextReferenceAttemptAt),
    });
  },

  toRecord(transaction: WagerTransaction): WagerTransactionRecordData {
    const { provider } = transaction;
    return {
      id: transaction.id,
      providerId: orNull(provider?.providerId),
      externalTransactionId: orNull(provider?.externalTransactionId),
      idempotencyKey: orNull(provider?.idempotencyKey),
      roundId: orNull(provider?.roundId),
      gameId: orNull(provider?.gameId),
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      kind: transaction.kind,
      amount: transaction.money.toJSON().amount,
      currency: transaction.money.currency,
      referenceExternalTransactionId: orNull(transaction.referenceExternalTransactionId),
      payloadHash: orNull(transaction.payloadHash),
      createdAt: transaction.createdAt,
      status: transaction.status,
      referenceTransactionId: orNull(transaction.referenceTransactionId),
      failureCode: orNull(transaction.failureCode),
      processedAt: orNull(transaction.processedAt),
      resolvedAt: orNull(transaction.resolvedAt),
      balanceAfter: orNull(transaction.balanceAfter?.toJSON().amount),
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceAttemptAt: orNull(transaction.nextReferenceAttemptAt),
    };
  },
};

function providerFrom(record: WagerTransactionRecordData): ProviderRef | undefined {
  if (record.providerId == null) {
    return undefined;
  }
  return {
    providerId: record.providerId,
    externalTransactionId: required(record.externalTransactionId),
    idempotencyKey: required(record.idempotencyKey),
    roundId: required(record.roundId),
    gameId: required(record.gameId),
  };
}

function required(value: string | null | undefined): string {
  if (value == null) {
    throw new InvariantViolationError('provider fields must be all present or all absent');
  }
  return value;
}
