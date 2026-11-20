import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';

export interface LedgerPosition {
  createdAt: Date;
  id: string;
}

export interface WalletLedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
  findPage(walletId: string, after: LedgerPosition | undefined, limit: number): Promise<WalletLedgerEntry[]>;
}

export const WALLET_LEDGER_REPOSITORY = Symbol('WALLET_LEDGER_REPOSITORY');
