import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { UnitOfWork } from '../ports/unit-of-work';

export class GetWagerTransactionQuery {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  byId(transactionId: string): Promise<WagerTransaction | null> {
    return this.unitOfWork.runReadOnly(({ transactions }) => transactions.findById(transactionId));
  }

  byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.unitOfWork.runReadOnly(({ transactions }) =>
      transactions.findByExternalId(providerId, externalTransactionId),
    );
  }
}
