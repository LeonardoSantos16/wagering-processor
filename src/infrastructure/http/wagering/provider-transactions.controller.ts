import { Controller, Get, Param } from '@nestjs/common';
import { z } from 'zod';
import { GetWagerTransactionQuery } from '../../../application/queries/get-wager-transaction.query';
import { text } from '../../validation/schemas';
import { ResourceNotFoundError } from '../errors/resource-not-found.error';
import { ZodValidationPipe } from '../validation/zod-validation.pipe';
import { toWagerTransactionView } from './wager-transaction-view';

const providerTransactionParamsSchema = z.object({ providerId: text, externalTransactionId: text });

type ProviderTransactionParams = z.infer<typeof providerTransactionParamsSchema>;

@Controller('providers/:providerId/wagering/transactions')
export class ProviderTransactionsController {
  constructor(private readonly getTransaction: GetWagerTransactionQuery) {}

  @Get(':externalTransactionId')
  async findByExternalId(
    @Param(new ZodValidationPipe(providerTransactionParamsSchema))
    { providerId, externalTransactionId }: ProviderTransactionParams,
  ) {
    const transaction = await this.getTransaction.byExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw ResourceNotFoundError.transaction(`${providerId}/${externalTransactionId}`);
    }
    return toWagerTransactionView(transaction);
  }
}
