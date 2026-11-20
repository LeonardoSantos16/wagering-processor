import { z } from 'zod';
import type { ProcessWagerTransactionCommand } from '../../application/use-cases/process-wager-transaction.use-case';
import { Money } from '../../domain/money/money';
import { text } from '../validation/schemas';
import { parseSubmittableKind, wagerTransactionRequestSchema } from '../validation/wager-transaction-request';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

const wagerTransactionMessageSchema = z.object({
  messageId: text,
  type: z.literal(WAGER_TRANSACTION_REQUESTED),
  occurredAt: z.iso.datetime(),
  data: wagerTransactionRequestSchema.extend({ idempotencyKey: text }),
});

export class InvalidMessageError extends Error {
  constructor(readonly reason: string) {
    super(`invalid message: ${reason}`);
    this.name = 'InvalidMessageError';
  }
}

export function parseWagerTransactionMessage(
  body: string | undefined,
  consumerName: string,
): ProcessWagerTransactionCommand {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new InvalidMessageError('body is not valid JSON');
  }
  const parsed = wagerTransactionMessageSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidMessageError(z.prettifyError(parsed.error));
  }
  const { messageId, data } = parsed.data;
  return {
    provider: {
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      idempotencyKey: data.idempotencyKey,
      roundId: data.roundId,
      gameId: data.gameId,
    },
    walletId: data.walletId,
    playerId: data.playerId,
    kind: parseSubmittableKind(data.kind),
    money: Money.from(data.money),
    referenceExternalTransactionId: data.referenceExternalTransactionId,
    correlationId: messageId,
    inbox: { consumerName, messageId },
  };
}
