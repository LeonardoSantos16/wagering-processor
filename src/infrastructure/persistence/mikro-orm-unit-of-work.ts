import {
  DeadlockException,
  DriverException,
  IsolationLevel,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  DuplicateIdempotencyKeyError,
  ExternalTransactionConflictError,
  TemporarilyUnavailableError,
  WalletAlreadyExistsError,
} from '../../application/errors/persistence.errors';
import type { TransactionalRepositories, UnitOfWork } from '../../application/ports/unit-of-work';
import { MikroOrmWalletLedgerRepository } from './ledger/mikro-orm-wallet-ledger.repository';
import { MikroOrmInboxRepository } from './messaging/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from './messaging/mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from './wager-transaction/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from './wallet/mikro-orm-wallet.repository';

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly options: UnitOfWorkOptions,
  ) {
    if (!Number.isInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0) {
      throw new Error(`Invalid lock timeout: ${options.lockTimeoutMs}`);
    }
  }

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (em) => {
          await em.execute(`set local lock_timeout = ${this.options.lockTimeoutMs}`);
          return work(repositoriesFor(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translate(error);
    }
  }
}

const UNIQUE_VIOLATIONS: Record<string, () => Error> = {
  wallet_player_currency_unique: () => new WalletAlreadyExistsError(),
  wager_transaction_provider_external_id_unique: () => new ExternalTransactionConflictError(),
  wager_transaction_provider_idempotency_key_unique: () => new DuplicateIdempotencyKeyError(),
};

const LOCK_NOT_AVAILABLE = '55P03';

function translate(error: unknown): unknown {
  if (error instanceof DriverException && error.code === LOCK_NOT_AVAILABLE) {
    return new TemporarilyUnavailableError('timed out waiting for a wallet lock');
  }
  if (error instanceof DeadlockException) {
    return new TemporarilyUnavailableError('transaction aborted by a concurrent conflict');
  }
  if (error instanceof UniqueConstraintViolationException) {
    const constraint = (error as UniqueConstraintViolationException & { constraint?: string }).constraint;
    const translated = constraint ? UNIQUE_VIOLATIONS[constraint] : undefined;
    return translated ? translated() : error;
  }
  return error;
}

function repositoriesFor(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmWalletLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}
