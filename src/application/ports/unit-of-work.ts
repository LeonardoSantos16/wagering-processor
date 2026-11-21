import type { InboxRepository } from './inbox.repository';
import type { OutboxRepository } from './outbox.repository';
import type { WagerTransactionRepository } from './wager-transaction.repository';
import type { WalletLedgerRepository } from './wallet-ledger.repository';
import type { WalletRepository } from './wallet.repository';

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: WalletLedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
  runReadOnly<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
