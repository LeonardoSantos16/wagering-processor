import { DomainError } from '../errors/domain-error';
import { FailureCode } from '../errors/failure-code';

export class InvalidKindError extends DomainError {
  readonly code = FailureCode.InvalidKind;

  constructor(kind: string) {
    super(`transaction kind not accepted: ${kind}`);
  }
}

export class MissingReferenceError extends DomainError {
  readonly code = FailureCode.MissingReference;

  constructor(kind: string) {
    super(`${kind} requires referenceExternalTransactionId`);
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(transactionId: string, from: string, action: string) {
    super(`transaction ${transactionId} cannot ${action} from status ${from}`);
    this.name = 'InvalidTransactionStateError';
  }
}
