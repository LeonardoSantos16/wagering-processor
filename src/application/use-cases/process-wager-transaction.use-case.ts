import { FailureCode } from '../../domain/errors/failure-code';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import type { ProviderRef } from '../../domain/wagering/wager-transaction.types';
import type { Wallet } from '../../domain/wallet/wallet';
import { DuplicateIdempotencyKeyError, ExternalTransactionConflictError } from '../errors/persistence.errors';
import { IdempotencyConflictError, WalletNotFoundError } from '../errors/wager-transaction.errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { TransactionalRepositories, UnitOfWork } from '../ports/unit-of-work';

export interface ProcessWagerTransactionCommand {
  provider: ProviderRef;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
}

export interface ProcessWagerTransactionResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    try {
      return await this.attempt(command);
    } catch (error) {
      if (!(error instanceof DuplicateIdempotencyKeyError)) {
        throw error;
      }
      return this.attempt(command);
    }
  }

  private attempt(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const now = this.clock.now();
    const candidate = WagerTransaction.create({
      id: this.ids.next(),
      provider: command.provider,
      walletId: command.walletId,
      playerId: command.playerId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      now,
    });

    return this.unitOfWork.run(async (repositories) => {
      const { wallets, transactions } = repositories;
      const wallet = await wallets.findByIdForUpdate(command.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(command.walletId);
      }

      const { providerId, idempotencyKey, externalTransactionId } = command.provider;
      const previous = await transactions.findByIdempotencyKey(providerId, idempotencyKey);
      if (previous) {
        if (!previous.matchesPayload(candidate.payloadHash!)) {
          throw new IdempotencyConflictError();
        }
        return { transaction: previous, idempotentReplay: true };
      }
      if (await transactions.findByExternalId(providerId, externalTransactionId)) {
        throw new ExternalTransactionConflictError();
      }

      if (candidate.referenceExternalTransactionId !== undefined) {
        throw new Error('reference resolution is not implemented yet');
      }

      const events = this.apply(candidate, wallet, now, command.correlationId);
      await this.persist(repositories, candidate, wallet, events);
      return { transaction: candidate, idempotentReplay: false };
    });
  }

  private apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
    correlationId: string,
  ): { entry?: WalletLedgerEntry; events: IntegrationEvent<unknown>[] } {
    const context = (): EventContext => ({ eventId: this.ids.next(), correlationId, occurredAt: now });

    const rejection = this.rejectionFor(transaction, wallet);
    if (rejection) {
      transaction.reject({
        code: rejection,
        balanceAfter: rejection === FailureCode.CurrencyMismatch ? undefined : wallet.balance,
        at: now,
      });
      return { events: [WagerTransactionRejected.from(transaction, context())] };
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed({ balanceAfter: wallet.balance, at: now });
      return { events: [WagerTransactionProcessed.from(transaction, context())] };
    }

    const movement = { amount: transaction.money, transactionId: transaction.id, entryId: this.ids.next(), now };
    const entry =
      transaction.ledgerDirectionFor() === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    transaction.markProcessed({ balanceAfter: wallet.balance, at: now });
    return {
      entry,
      events: [
        WagerTransactionProcessed.from(transaction, context()),
        WalletBalanceChanged.from(wallet, entry, context()),
      ],
    };
  }

  private rejectionFor(transaction: WagerTransaction, wallet: Wallet): FailureCode | undefined {
    if (transaction.money.currency !== wallet.currency) {
      return FailureCode.CurrencyMismatch;
    }
    if (transaction.playerId !== wallet.playerId) {
      return FailureCode.PlayerWalletMismatch;
    }
    if (
      transaction.affectsBalance() &&
      transaction.ledgerDirectionFor() === LedgerDirection.Debit &&
      !wallet.canDebit(transaction.money)
    ) {
      return FailureCode.InsufficientFunds;
    }
    return undefined;
  }

  private async persist(
    { wallets, transactions, ledger, outbox }: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    { entry, events }: { entry?: WalletLedgerEntry; events: IntegrationEvent<unknown>[] },
  ): Promise<void> {
    await transactions.save(transaction);
    if (entry) {
      await wallets.save(wallet);
      await ledger.append(entry);
    }
    for (const event of events) {
      await outbox.save(OutboxMessage.enqueue(event));
    }
  }
}
