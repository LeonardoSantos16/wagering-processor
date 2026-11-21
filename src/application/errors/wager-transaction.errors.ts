import { DomainError } from '../../domain/errors/domain-error';
import { FailureCode } from '../../domain/errors/failure-code';

export class WalletNotFoundError extends DomainError {
  readonly code = FailureCode.WalletNotFound;

  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = FailureCode.IdempotencyConflict;

  constructor() {
    super('idempotency key already used with a different payload');
  }
}

export class InboxMessageConflictError extends Error {
  constructor(messageId: string) {
    super(`message ${messageId} already received with a different payload`);
    this.name = 'InboxMessageConflictError';
  }
}
