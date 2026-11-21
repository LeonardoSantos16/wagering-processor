import { DomainError } from '../../../domain/errors/domain-error';
import { FailureCode } from '../../../domain/errors/failure-code';

export class MissingIdempotencyKeyError extends DomainError {
  readonly code = FailureCode.MissingIdempotencyKey;

  constructor() {
    super('the Idempotency-Key header is required');
  }
}
