import type { IncomingMessage, ServerResponse } from 'node:http';
import { Body, Controller, Headers, Post, Req, Res } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { z } from 'zod';
import {
  type ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from '../../../application/use-cases/process-wager-transaction.use-case';
import { Money } from '../../../domain/money/money';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import { InvalidKindError } from '../../../domain/wagering/wager-transaction.errors';
import { MissingIdempotencyKeyError } from '../errors/missing-idempotency-key.error';
import { RequestValidationError } from '../errors/request-validation.error';
import { moneySchema, text } from '../validation/schemas';
import { ZodValidationPipe } from '../validation/zod-validation.pipe';

const submitTransactionSchema = z.object({
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

type SubmitTransactionBody = z.infer<typeof submitTransactionSchema>;

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set(
  Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening),
);

const HTTP_STATUS_BY_TRANSACTION_STATUS: Partial<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 201,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller('wagering/transactions')
export class WageringTransactionsController {
  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodValidationPipe(submitTransactionSchema)) body: SubmitTransactionBody,
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const result = await this.processTransaction.execute({
      provider: {
        providerId: body.providerId,
        externalTransactionId: body.externalTransactionId,
        idempotencyKey: parseIdempotencyKey(idempotencyKeyHeader),
        roundId: body.roundId,
        gameId: body.gameId,
      },
      walletId: body.walletId,
      playerId: body.playerId,
      kind: parseKind(body.kind),
      money: Money.from(body.money),
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId: String(request.id),
    });

    const [status, payload] = toResponse(result);
    this.adapterHost.httpAdapter.reply(response, payload, status);
  }
}

function parseIdempotencyKey(header: string | undefined): string {
  const key = header?.trim();
  if (!key) {
    throw new MissingIdempotencyKeyError();
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new RequestValidationError([
      { path: 'Idempotency-Key', message: `must have at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` },
    ]);
  }
  return key;
}

function parseKind(kind: string): WagerTransactionKind {
  if (!SUBMITTABLE_KINDS.has(kind)) {
    throw new InvalidKindError(kind);
  }
  return kind as WagerTransactionKind;
}

function toResponse({ transaction, idempotentReplay }: ProcessWagerTransactionResult): [number, object] {
  const status = HTTP_STATUS_BY_TRANSACTION_STATUS[transaction.status];
  if (status === undefined) {
    throw new Error(`transaction ${transaction.id} returned in status ${transaction.status}`);
  }
  return [
    status,
    {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.balanceAfter?.toJSON() ?? null,
      ...(transaction.failureCode !== undefined && { failureCode: transaction.failureCode }),
      idempotentReplay,
    },
  ];
}
