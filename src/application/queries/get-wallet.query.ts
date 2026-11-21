import type { Wallet } from '../../domain/wallet/wallet';
import type { UnitOfWork } from '../ports/unit-of-work';

export class GetWalletQuery {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(walletId: string): Promise<Wallet | null> {
    return this.unitOfWork.runReadOnly(({ wallets }) => wallets.findById(walletId));
  }
}
