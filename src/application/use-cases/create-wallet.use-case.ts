import type { EventContext } from '../../domain/events/integration-event';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const now = this.clock.now();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.next(),
      now,
    });

    await this.unitOfWork.run(async ({ wallets, transactions, ledger, outbox }) => {
      await wallets.save(wallet);
      if (!openingEntry) {
        return;
      }

      const opening = WagerTransaction.opening({
        id: openingTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: command.initialBalance,
        now,
      });
      await transactions.save(opening);
      await ledger.append(openingEntry);

      const context = (): EventContext => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        occurredAt: now,
      });
      await outbox.save(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, context())));
      await outbox.save(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, context())));
    });

    return wallet;
  }
}
