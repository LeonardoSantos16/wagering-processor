import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';

export function toWagerTransactionView(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.provider?.providerId ?? null,
    externalTransactionId: transaction.provider?.externalTransactionId ?? null,
    roundId: transaction.provider?.roundId ?? null,
    gameId: transaction.provider?.gameId ?? null,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    balance: transaction.balanceAfter?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
    resolvedAt: transaction.resolvedAt?.toISOString() ?? null,
  };
}
