import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletLedgerRepository } from '../../../application/ports/wallet-ledger.repository';
import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { WalletLedgerEntryRecord } from './wallet-ledger-entry.entity';
import { WalletLedgerEntryMapper } from './wallet-ledger-entry.mapper';

export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    this.em.create(WalletLedgerEntryRecord, WalletLedgerEntryMapper.toRecord(entry));
  }

  async findByWallet(walletId: string): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      WalletLedgerEntryRecord,
      { walletId },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );
    return records.map(WalletLedgerEntryMapper.toDomain);
  }
}
