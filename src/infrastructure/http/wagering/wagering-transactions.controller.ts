import type { IncomingMessage, ServerResponse } from 'node:http';
import { Body, Controller, Headers, Post, Req, Res } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  type ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from '../../../application/use-cases/process-wager-transaction.use-case';
import { Money } from '../../../domain/money/money';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import {
  parseSubmittableKind,
  type WagerTransactionRequest,
  wagerTransactionRequestSchema,
} from '../../validation/wager-transaction-request';
import { MissingIdempotencyKeyError } from '../errors/missing-idempotency-key.error';
import { RequestValidationError } from '../errors/request-validation.error';
import { ZodValidationPipe } from '../validation/zod-validation.pipe';

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

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
    @Body(new ZodValidationPipe(wagerTransactionRequestSchema)) body: WagerTransactionRequest,
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
      kind: parseSubmittableKind(body.kind),
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
