import { DomainError } from '../../../domain/errors/domain-error';
import { FailureCode } from '../../../domain/errors/failure-code';

export interface ValidationIssue {
  path: string;
  message: string;
}

export class RequestValidationError extends DomainError {
  readonly code = FailureCode.InvalidPayload;

  constructor(readonly issues: ValidationIssue[]) {
    super('request payload is invalid');
  }
}
