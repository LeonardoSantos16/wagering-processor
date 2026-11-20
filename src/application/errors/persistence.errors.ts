import { DomainError } from '../../domain/errors/domain-error';
import { FailureCode } from '../../domain/errors/failure-code';

export class WalletAlreadyExistsError extends DomainError {
  readonly code = FailureCode.WalletAlreadyExists;

  constructor() {
    super('a wallet already exists for this player and currency');
  }
}

export class ExternalTransactionConflictError extends DomainError {
  readonly code = FailureCode.ExternalTransactionConflict;

  constructor() {
    super('external transaction id already used by another transaction of this provider');
  }
}

export class TemporarilyUnavailableError extends DomainError {
  readonly code = FailureCode.TemporarilyUnavailable;

  constructor(reason: string) {
    super(`temporarily unavailable: ${reason}`);
  }
}

export class DuplicateIdempotencyKeyError extends Error {
  constructor() {
    super('idempotency key committed concurrently by another request');
    this.name = 'DuplicateIdempotencyKeyError';
  }
}
