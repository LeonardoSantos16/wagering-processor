import { Body, Controller, Get, HttpCode, Logger, Param, Post, Query, Req } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { WalletLedgerPage } from '../../../application/queries/list-wallet-ledger.query';
import { GetWalletQuery } from '../../../application/queries/get-wallet.query';
import { ListWalletLedgerQuery } from '../../../application/queries/list-wallet-ledger.query';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case';
import {
  ReconcileWalletUseCase,
  type WalletReconciliation,
} from '../../../application/use-cases/reconcile-wallet.use-case';
import { Money } from '../../../domain/money/money';
import type { Wallet } from '../../../domain/wallet/wallet';
import { moneySchema, text } from '../../validation/schemas';
import { ResourceNotFoundError } from '../errors/resource-not-found.error';
import { ZodValidationPipe } from '../validation/zod-validation.pipe';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

const DEFAULT_LEDGER_PAGE_SIZE = 50;
const MAX_LEDGER_PAGE_SIZE = 100;

const createWalletSchema = z.object({
  playerId: text,
  initialBalance: moneySchema,
});

type CreateWalletBody = z.infer<typeof createWalletSchema>;

const walletParamsSchema = z.object({ walletId: z.uuid() });

type WalletParams = z.infer<typeof walletParamsSchema>;

const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LEDGER_PAGE_SIZE).default(DEFAULT_LEDGER_PAGE_SIZE),
  cursor: z
    .string()
    .optional()
    .transform((cursor, ctx) => {
      if (cursor === undefined) {
        return undefined;
      }
      const position = decodeLedgerCursor(cursor);
      if (!position) {
        ctx.addIssue({ code: 'custom', message: 'invalid cursor' });
        return z.NEVER;
      }
      return position;
    }),
});

type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

@Controller('wallets')
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletQuery,
    private readonly listLedger: ListWalletLedgerQuery,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

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

  @Get(':walletId')
  async findOne(@Param(new ZodValidationPipe(walletParamsSchema)) { walletId }: WalletParams) {
    const wallet = await this.getWallet.execute(walletId);
    if (!wallet) {
      throw ResourceNotFoundError.wallet(walletId);
    }
    return toWalletResponse(wallet);
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param(new ZodValidationPipe(walletParamsSchema)) { walletId }: WalletParams,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
  ) {
    const page = await this.listLedger.execute({ walletId, after: query.cursor, limit: query.limit });
    if (!page) {
      throw ResourceNotFoundError.wallet(walletId);
    }
    return toLedgerPageResponse(page);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param(new ZodValidationPipe(walletParamsSchema)) { walletId }: WalletParams) {
    const reconciliation = await this.reconcileWallet.execute(walletId);
    if (!reconciliation) {
      throw ResourceNotFoundError.wallet(walletId);
    }
    const response = toReconciliationResponse(reconciliation);
    if (!reconciliation.consistent) {
      this.logger.error({ msg: 'wallet balance diverges from the ledger', ...response });
    }
    return response;
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

function toLedgerPageResponse(page: WalletLedgerPage) {
  return {
    items: page.entries.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: page.next ? encodeLedgerCursor(page.next) : null,
  };
}

function toReconciliationResponse(reconciliation: WalletReconciliation) {
  return {
    walletId: reconciliation.walletId,
    storedBalance: reconciliation.storedBalance.toJSON(),
    calculatedBalance: reconciliation.calculatedBalance.toJSON(),
    difference: reconciliation.difference.toJSON(),
    consistent: reconciliation.consistent,
    checkedEntries: reconciliation.checkedEntries,
  };
}
