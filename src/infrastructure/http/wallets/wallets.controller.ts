import { Body, Controller, Post, Req } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case';
import { Money } from '../../../domain/money/money';
import type { Wallet } from '../../../domain/wallet/wallet';
import { moneySchema, text } from '../../validation/schemas';
import { ZodValidationPipe } from '../validation/zod-validation.pipe';

const createWalletSchema = z.object({
  playerId: text,
  initialBalance: moneySchema,
});

type CreateWalletBody = z.infer<typeof createWalletSchema>;

@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWallet: CreateWalletUseCase) {}

  @Post()
  async create(
    @Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletBody,
    @Req() request: IncomingMessage,
  ) {
    const wallet = await this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: Money.from(body.initialBalance),
      correlationId: String(request.id),
    });
    return toWalletResponse(wallet);
  }
}

function toWalletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
