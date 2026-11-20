import { FailureCode } from '../../../domain/errors/failure-code';

export const HTTP_STATUS_BY_FAILURE_CODE: Record<FailureCode, number> = {
  [FailureCode.InvalidPayload]: 400,
  [FailureCode.InvalidMoney]: 400,
  [FailureCode.InvalidKind]: 400,
  [FailureCode.MissingReference]: 400,
  [FailureCode.MissingIdempotencyKey]: 400,

  [FailureCode.IdempotencyConflict]: 409,
  [FailureCode.ExternalTransactionConflict]: 409,
  [FailureCode.WalletAlreadyExists]: 409,

  [FailureCode.WalletNotFound]: 422,
  [FailureCode.TransactionNotFound]: 404,

  [FailureCode.InsufficientFunds]: 422,
  [FailureCode.ReversalInsufficientFunds]: 422,
  [FailureCode.CurrencyMismatch]: 422,
  [FailureCode.PlayerWalletMismatch]: 422,
  [FailureCode.ReferenceNotFound]: 422,
  [FailureCode.ReferenceMismatch]: 422,
  [FailureCode.InvalidReferenceKind]: 422,
  [FailureCode.ReferenceNotProcessed]: 422,
  [FailureCode.AlreadyReversed]: 422,
  [FailureCode.AmountMismatch]: 422,

  [FailureCode.TemporarilyUnavailable]: 503,

  [FailureCode.ProcessingFailed]: 500,
};
