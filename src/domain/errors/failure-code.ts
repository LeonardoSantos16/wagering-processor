export enum FailureCode {
  // Invalid payload
  InvalidPayload = 'INVALID_PAYLOAD',
  InvalidMoney = 'INVALID_MONEY',
  InvalidKind = 'INVALID_KIND',
  MissingReference = 'MISSING_REFERENCE',
  MissingIdempotencyKey = 'MISSING_IDEMPOTENCY_KEY',

  // Conflict
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  ExternalTransactionConflict = 'EXTERNAL_TRANSACTION_CONFLICT',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',

  // Not found
  WalletNotFound = 'WALLET_NOT_FOUND',
  TransactionNotFound = 'TRANSACTION_NOT_FOUND',

  // Business rejection
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed = 'ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',

  // Transient failure
  TemporarilyUnavailable = 'TEMPORARILY_UNAVAILABLE',

  // Permanent failure
  ProcessingFailed = 'PROCESSING_FAILED',
}
