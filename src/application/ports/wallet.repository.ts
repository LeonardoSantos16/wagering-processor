import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
