import { DomainError } from '../../../domain/errors/domain-error';
import { FailureCode } from '../../../domain/errors/failure-code';

export class ResourceNotFoundError extends DomainError {
  constructor(
    readonly code: FailureCode.WalletNotFound | FailureCode.TransactionNotFound,
    message: string,
  ) {
    super(message);
  }

  static wallet(walletId: string): ResourceNotFoundError {
    return new ResourceNotFoundError(FailureCode.WalletNotFound, `wallet ${walletId} not found`);
  }

  static transaction(description: string): ResourceNotFoundError {
    return new ResourceNotFoundError(FailureCode.TransactionNotFound, `transaction ${description} not found`);
  }
}
