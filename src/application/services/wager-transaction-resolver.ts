import { FailureCode } from '../../domain/errors/failure-code';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import { WagerTransactionProcessed, WagerTransactionRejected } from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { IdGenerator } from '../ports/id-generator';
import type { TransactionalRepositories } from '../ports/unit-of-work';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';

export type Resolution = { type: 'reject'; code: FailureCode } | { type: 'process'; reference?: WagerTransaction };

export type Decision = Resolution | { type: 'missingReference' };

export interface Outcome {
  entry?: WalletLedgerEntry;
  events: IntegrationEvent<unknown>[];
}

export class WagerTransactionResolver {
  constructor(private readonly ids: IdGenerator) {}

  async decide(
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
        return { type: 'missingReference' };
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

  apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    resolution: Resolution,
    now: Date,
    correlationId: string,
  ): Outcome {
    const context = () => this.eventContext(now, correlationId);

    if (resolution.type === 'reject') {
      transaction.reject({
        code: resolution.code,
        balanceAfter: resolution.code === FailureCode.CurrencyMismatch ? undefined : wallet.balance,
        at: now,
      });
      return { events: [WagerTransactionRejected.from(transaction, context())] };
    }

    const { reference } = resolution;
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

  eventContext(now: Date, correlationId: string): EventContext {
    return { eventId: this.ids.next(), correlationId, occurredAt: now };
  }

  async persist(
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
