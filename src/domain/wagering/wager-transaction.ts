import { FailureCode } from '../errors/failure-code';
import { InvariantViolationError } from '../errors/invariant-violation.error';
import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import type { Money } from '../money/money';
import { InvalidMoneyError } from '../money/money.errors';
import type { Wallet } from '../wallet/wallet';
import { computePayloadHash } from './payload-hash';
import {
  ALLOWED_REFERENCE_KINDS,
  KINDS_REQUIRING_REFERENCE,
  WagerTransactionKind,
} from './wager-transaction-kind';
import { TERMINAL_STATUSES, WagerTransactionStatus } from './wager-transaction-status';
import {
  InvalidKindError,
  InvalidTransactionStateError,
  MissingReferenceError,
} from './wager-transaction.errors';
import type {
  CreateWagerTransactionProps,
  FailProps,
  MarkProcessedProps,
  OpeningTransactionProps,
  ProviderRef,
  RejectProps,
  WagerTransactionState,
} from './wager-transaction.types';

export class WagerTransaction {
  readonly id: string;
  readonly provider: ProviderRef | undefined;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly payloadHash: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _resolvedAt: Date | undefined;
  private _balanceAfter: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.provider = state.provider;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.payloadHash = state.payloadHash;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._resolvedAt = state.resolvedAt;
    this._balanceAfter = state.balanceAfter;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
  }

  /** Provider transaction, born PENDING. Validates the rules that depend only on its own data. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidKindError(props.kind);
    }
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new MissingReferenceError(props.kind);
    }
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError('transaction amount must be positive');
    }

    const payloadHash = computePayloadHash({
      providerId: props.provider.providerId,
      externalTransactionId: props.provider.externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: props.provider.roundId,
      gameId: props.provider.gameId,
      kind: props.kind,
      money: props.money.toJSON(),
      referenceExternalTransactionId: props.referenceExternalTransactionId,
    });

    return new WagerTransaction({
      id: props.id,
      provider: { ...props.provider },
      walletId: props.walletId,
      playerId: props.playerId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      payloadHash,
      createdAt: props.now,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError('opening amount must be positive');
    }
    return new WagerTransaction({
      id: props.id,
      walletId: props.walletId,
      playerId: props.playerId,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.now,
      status: WagerTransactionStatus.Processed,
      processedAt: props.now,
      resolvedAt: props.now,
      balanceAfter: props.money,
      referenceAttempts: 0,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resolvedAt(): Date | undefined {
    return this._resolvedAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  markProcessed(props: MarkProcessedProps): void {
    this.assertResolvable('markProcessed');
    const hasReference = this.referenceExternalTransactionId !== undefined;
    if (hasReference && !props.referenceTransactionId) {
      throw new InvariantViolationError('a transaction with a reference needs its internal id');
    }
    if (!hasReference && props.referenceTransactionId) {
      throw new InvariantViolationError('a transaction without a reference cannot record one');
    }
    this.assertBalanceCurrency(props.balanceAfter);

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._balanceAfter = props.balanceAfter;
    this._processedAt = props.at;
    this.resolve(props.at);
  }

  /** PENDING | PENDING_REFERENCE -> REJECTED. */
  reject(props: RejectProps): void {
    this.assertResolvable('reject');
    if (props.code === FailureCode.CurrencyMismatch) {
      if (props.balanceAfter !== undefined) {
        throw new InvariantViolationError('a CURRENCY_MISMATCH rejection cannot record a balance');
      }
    } else if (props.balanceAfter === undefined) {
      throw new InvariantViolationError('a rejection must record the observed balance');
    } else {
      this.assertBalanceCurrency(props.balanceAfter);
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = props.code;
    this._balanceAfter = props.balanceAfter;
    this.resolve(props.at);
  }

  fail(props: FailProps): void {
    this.assertResolvable('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = props.code;
    this.resolve(props.at);
  }

  markPendingReference(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this.id, this._status, 'markPendingReference');
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError('only a transaction with a reference can wait for it');
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this.id, this._status, 'scheduleReferenceRetry');
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  private assertBalanceCurrency(balance: Money): void {
    if (balance.currency !== this.money.currency) {
      throw new InvariantViolationError('balanceAfter must be in the transaction currency');
    }
  }

  private assertResolvable(action: string): void {
    if (
      this._status !== WagerTransactionStatus.Pending &&
      this._status !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidTransactionStateError(this.id, this._status, action);
    }
  }

  private resolve(at: Date): void {
    this._resolvedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  checkWallet(wallet: Wallet): FailureCode | undefined {
    if (wallet.id !== this.walletId) {
      throw new InvariantViolationError('a transaction can only be checked against its own wallet');
    }
    if (wallet.currency !== this.money.currency) {
      return FailureCode.CurrencyMismatch;
    }
    if (wallet.playerId !== this.playerId) {
      return FailureCode.PlayerWalletMismatch;
    }
    return undefined;
  }

  checkReference(reference: WagerTransaction): FailureCode | undefined {
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError('this transaction has no reference to check');
    }
    if (!this.sharesContextWith(reference)) {
      return FailureCode.ReferenceMismatch;
    }
    if (!ALLOWED_REFERENCE_KINDS[this.kind].has(reference.kind)) {
      return FailureCode.InvalidReferenceKind;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  private sharesContextWith(reference: WagerTransaction): boolean {
    return (
      this.provider !== undefined &&
      reference.provider !== undefined &&
      reference.provider.providerId === this.provider.providerId &&
      reference.provider.roundId === this.provider.roundId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency
    );
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError('ROLLBACK requires the reverted transaction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not produce a ledger entry');
    }
  }
}
