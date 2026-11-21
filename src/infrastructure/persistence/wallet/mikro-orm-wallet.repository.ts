import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletRepository } from '../../../application/ports/wallet.repository';
import type { Wallet } from '../../../domain/wallet/wallet';
import { WalletRecord } from './wallet.entity';
import { WalletMapper } from './wallet.mapper';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? WalletMapper.toDomain(record) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? WalletMapper.toDomain(record) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    const data = WalletMapper.toRecord(wallet);
    const managed = this.em.getUnitOfWork().getById(WalletRecord, wallet.id);
    if (managed) {
      this.em.assign(managed, data);
    } else {
      this.em.create(WalletRecord, data);
    }
  }
}
