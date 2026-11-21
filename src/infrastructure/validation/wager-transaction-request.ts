import { z } from 'zod';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import { InvalidKindError } from '../../domain/wagering/wager-transaction.errors';
import { moneySchema, text } from './schemas';

export const wagerTransactionRequestSchema = z.object({
  providerId: text,
  externalTransactionId: text,
  playerId: text,
  walletId: z.uuid(),
  roundId: text,
  gameId: text,
  kind: z.string(),
  money: moneySchema,
  referenceExternalTransactionId: text.optional(),
});

export type WagerTransactionRequest = z.infer<typeof wagerTransactionRequestSchema>;

const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set(
  Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening),
);

export function parseSubmittableKind(kind: string): WagerTransactionKind {
  if (!SUBMITTABLE_KINDS.has(kind)) {
    throw new InvalidKindError(kind);
  }
  return kind as WagerTransactionKind;
}
