import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';

export interface WalletLedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
}

export const WALLET_LEDGER_REPOSITORY = Symbol('WALLET_LEDGER_REPOSITORY');
