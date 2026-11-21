import { DomainError } from '../errors/domain-error';
import { FailureCode } from '../errors/failure-code';

export class CurrencyMismatchError extends DomainError {
  readonly code = FailureCode.CurrencyMismatch;

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = FailureCode.InvalidMoney;

  constructor(message: string) {
    super(message);
  }
}
