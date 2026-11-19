import type { FailureCode } from '../errors/failure-code';
import type { Money } from '../money/money';
import type { WagerTransactionKind } from './wager-transaction-kind';
import type { WagerTransactionStatus } from './wager-transaction-status';

export interface ProviderRef {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  roundId: string;
  gameId: string;
}

export interface CreateWagerTransactionProps {
  id: string;
  provider: ProviderRef;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  now: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  now: Date;
}

export interface WagerTransactionState {
  id: string;
  provider?: ProviderRef;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  payloadHash?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resolvedAt?: Date;
  balanceAfter?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

export interface MarkProcessedProps {
  referenceTransactionId?: string;
  balanceAfter: Money;
  at: Date;
}

export interface RejectProps {
  code: FailureCode;
  balanceAfter: Money;
  at: Date;
}

export interface FailProps {
  code: FailureCode;
  at: Date;
}
