import type { TransactionalRepositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';

export class ForcedFailure extends Error {
  constructor() {
    super('forced failure after writing to the database');
  }
}

export interface WritesSeenBeforeFailure {
  walletId: string;
  ledgerEntryIds: string[];
}

/**
 * Lets the real work run and fails on the first outbox write. Before failing it queries the ledger,
 * which makes MikroORM flush the pending inserts/updates, so the rollback undoes rows that were
 * really written inside the SQL transaction.
 */
export class FailingOnOutboxUnitOfWork implements UnitOfWork {
  readonly seen: WritesSeenBeforeFailure[] = [];

  constructor(private readonly inner: UnitOfWork) {}

  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    return this.inner.run((repositories) =>
      work({
        ...repositories,
        outbox: {
          findById: (id) => repositories.outbox.findById(id),
          findDueForUpdate: (now, limit) => repositories.outbox.findDueForUpdate(now, limit),
          save: async (message: OutboxMessage) => {
            await repositories.outbox.save(message);
            const walletId = String((message.payload.data as { walletId: string }).walletId);
            const entries = await repositories.ledger.findByWallet(walletId);
            this.seen.push({ walletId, ledgerEntryIds: entries.map((entry) => entry.id) });
            throw new ForcedFailure();
          },
        },
      }),
    );
  }
}
