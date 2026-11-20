import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-events';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import type { ProviderRef } from '../../domain/wagering/wager-transaction.types';
import { DuplicateIdempotencyKeyError, ExternalTransactionConflictError } from '../errors/persistence.errors';
import {
  IdempotencyConflictError,
  InboxMessageConflictError,
  WalletNotFoundError,
} from '../errors/wager-transaction.errors';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { InboxRepository } from '../ports/inbox.repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { PendingReferencePolicy } from '../services/pending-reference-policy';
import { type Outcome, WagerTransactionResolver } from '../services/wager-transaction-resolver';

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

export class ProcessWagerTransactionUseCase {
  private readonly resolver: WagerTransactionResolver;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly pendingReferences: PendingReferencePolicy,
  ) {
    this.resolver = new WagerTransactionResolver(ids);
  }

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

      const decision = await this.resolver.decide(candidate, wallet, providerId, transactions);
      const outcome =
        decision.type === 'missingReference'
          ? this.waitForReference(candidate, now, command.correlationId)
          : this.resolver.apply(candidate, wallet, decision, now, command.correlationId);
      await recordInbox();
      await this.resolver.persist(repositories, candidate, wallet, outcome);
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

  private waitForReference(transaction: WagerTransaction, now: Date, correlationId: string): Outcome {
    transaction.markPendingReference(this.pendingReferences.firstAttemptAt(transaction, now));
    return {
      events: [WagerTransactionPendingReference.from(transaction, this.resolver.eventContext(now, correlationId))],
    };
  }
}

function processedInbox({ consumerName, messageId }: InboxRef, payloadHash: string, now: Date): InboxMessage {
  const message = InboxMessage.receive({ consumerName, messageId, payloadHash, receivedAt: now });
  message.markProcessed(now);
  return message;
}
