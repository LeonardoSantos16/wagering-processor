import { DomainError } from '../errors/domain-error';
import { FailureCode } from '../errors/failure-code';

export class InsufficientFundsError extends DomainError {
  readonly code = FailureCode.InsufficientFunds;

  constructor(walletId: string) {
    super(`insufficient funds in wallet ${walletId}`);
  }
}
