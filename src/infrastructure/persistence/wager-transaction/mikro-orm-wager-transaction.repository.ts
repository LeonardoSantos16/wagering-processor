import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../../../application/ports/wager-transaction.repository';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import { WagerTransactionRecord } from './wager-transaction.entity';
import { WagerTransactionMapper } from './wager-transaction.mapper';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<WagerTransaction | null> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, idempotencyKey });
  }

  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: 'asc', id: 'asc' }, limit },
    );
    return records.map((record) => WagerTransactionMapper.toDomain(record));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const data = WagerTransactionMapper.toRecord(transaction);
    const managed = this.em.getUnitOfWork().getById(WagerTransactionRecord, transaction.id);
    if (managed) {
      this.em.assign(managed, data);
    } else {
      this.em.create(WagerTransactionRecord, data);
    }
  }

  private async findOne(
    where: Partial<Pick<WagerTransactionRecord, 'id' | 'providerId' | 'idempotencyKey' | 'externalTransactionId'>>,
  ): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, where);
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }
}
