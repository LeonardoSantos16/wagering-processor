import { FailureCode } from '../../domain/errors/failure-code';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wager-transaction-events';
import { computeBackoffDelay } from '../../domain/shared/backoff';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import type { ProviderRef } from '../../domain/wagering/wager-transaction.types';
import type { Wallet } from '../../domain/wallet/wallet';
import { DuplicateIdempotencyKeyError, ExternalTransactionConflictError } from '../errors/persistence.errors';
import {
  IdempotencyConflictError,
  InboxMessageConflictError,
  WalletNotFoundError,
} from '../errors/wager-transaction.errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { InboxRepository } from '../ports/inbox.repository';
import type { TransactionalRepositories, UnitOfWork } from '../ports/unit-of-work';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';

export interface ProcessWagerTransactionCommand {
  provider: ProviderRef;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  inbox?: InboxRef;
}

export interface InboxRef {
  consumerName: string;
  messageId: string;
}

export interface ProcessWagerTransactionResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

const PENDING_REFERENCE_BASE_DELAY_MS = 1_000;
const PENDING_REFERENCE_MAX_DELAY_MS = 60_000;

type Decision =
  | { type: 'reject'; code: FailureCode }
  | { type: 'pendingReference' }
  | { type: 'process'; reference?: WagerTransaction };

interface Outcome {
  entry?: WalletLedgerEntry;
  events: IntegrationEvent<unknown>[];
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

      const recordInbox = await this.checkInbox(repositories.inbox, command.inbox, candidate.payloadHash!, now);

      const { providerId, idempotencyKey, externalTransactionId } = command.provider;
      const previous = await transactions.findByIdempotencyKey(providerId, idempotencyKey);
      if (previous) {
        if (!previous.matchesPayload(candidate.payloadHash!)) {
          throw new IdempotencyConflictError();
        }
        await recordInbox();
        return { transaction: previous, idempotentReplay: true };
      }
      if (await transactions.findByExternalId(providerId, externalTransactionId)) {
        throw new ExternalTransactionConflictError();
      }

      const decision = await this.decide(candidate, wallet, providerId, transactions);
      const outcome = this.apply(candidate, wallet, decision, now, command.correlationId);
      await recordInbox();
      await this.persist(repositories, candidate, wallet, outcome);
      return { transaction: candidate, idempotentReplay: false };
    });
  }

  private async checkInbox(
    inbox: InboxRepository,
    ref: InboxRef | undefined,
    payloadHash: string,
    now: Date,
  ): Promise<() => Promise<void>> {
    if (!ref) {
      return async () => {};
    }
    const received = await inbox.find(ref.consumerName, ref.messageId);
    if (received) {
      if (!received.matchesPayload(payloadHash)) {
        throw new InboxMessageConflictError(ref.messageId);
      }
      return async () => {};
    }
    return () => inbox.save(processedInbox(ref, payloadHash, now));
  }

  private async decide(
    transaction: WagerTransaction,
    wallet: Wallet,
    providerId: string,
    transactions: WagerTransactionRepository,
  ): Promise<Decision> {
    const walletMismatch = transaction.checkWallet(wallet);
    if (walletMismatch) {
      return { type: 'reject', code: walletMismatch };
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      reference =
        (await transactions.findByExternalId(providerId, transaction.referenceExternalTransactionId)) ?? undefined;
      if (!reference) {
        return { type: 'pendingReference' };
      }
      const mismatch = transaction.checkReference(reference);
      if (mismatch) {
        return { type: 'reject', code: mismatch };
      }
      if (transaction.requiresReference() && (await transactions.findProcessedReversalOf(reference.id))) {
        return { type: 'reject', code: FailureCode.AlreadyReversed };
      }
    }

    if (
      transaction.affectsBalance() &&
      transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit &&
      !wallet.canDebit(transaction.money)
    ) {
      const code = transaction.requiresReference()
        ? FailureCode.ReversalInsufficientFunds
        : FailureCode.InsufficientFunds;
      return { type: 'reject', code };
    }
    return { type: 'process', reference };
  }

  private apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    decision: Decision,
    now: Date,
    correlationId: string,
  ): Outcome {
    const context = (): EventContext => ({ eventId: this.ids.next(), correlationId, occurredAt: now });

    switch (decision.type) {
      case 'reject':
        transaction.reject({
          code: decision.code,
          balanceAfter: decision.code === FailureCode.CurrencyMismatch ? undefined : wallet.balance,
          at: now,
        });
        return { events: [WagerTransactionRejected.from(transaction, context())] };

      case 'pendingReference': {
        const delay = computeBackoffDelay(1, PENDING_REFERENCE_BASE_DELAY_MS, PENDING_REFERENCE_MAX_DELAY_MS);
        transaction.markPendingReference(new Date(now.getTime() + delay));
        return { events: [WagerTransactionPendingReference.from(transaction, context())] };
      }

      case 'process': {
        const { reference } = decision;
        if (!transaction.affectsBalance()) {
          transaction.markProcessed({ referenceTransactionId: reference?.id, balanceAfter: wallet.balance, at: now });
          return { events: [WagerTransactionProcessed.from(transaction, context())] };
        }

        const movement = { amount: transaction.money, transactionId: transaction.id, entryId: this.ids.next(), now };
        const entry =
          transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
            ? wallet.debit(movement)
            : wallet.credit(movement);
        transaction.markProcessed({ referenceTransactionId: reference?.id, balanceAfter: wallet.balance, at: now });
        return {
          entry,
          events: [
            WagerTransactionProcessed.from(transaction, context()),
            WalletBalanceChanged.from(wallet, entry, context()),
          ],
        };
      }
    }
  }

  private async persist(
    { wallets, transactions, ledger, outbox }: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    { entry, events }: Outcome,
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

function processedInbox({ consumerName, messageId }: InboxRef, payloadHash: string, now: Date): InboxMessage {
  const message = InboxMessage.receive({ consumerName, messageId, payloadHash, receivedAt: now });
  message.markProcessed(now);
  return message;
}
