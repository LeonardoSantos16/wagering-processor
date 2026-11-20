import { LedgerDirection } from '../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../domain/money/money';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface WalletReconciliation {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWalletUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletReconciliation | null> {
    const snapshot = await this.unitOfWork.runReadOnly(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(walletId);
      return wallet && { wallet, entries: await ledger.findByWallet(walletId) };
    });
    if (!snapshot) {
      return null;
    }

    const { wallet, entries } = snapshot;
    const calculatedBalance = entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit ? balance.add(entry.money) : balance.subtract(entry.money),
      Money.zero(wallet.currency),
    );
    const difference = wallet.balance.subtract(calculatedBalance);
    return {
      walletId,
      storedBalance: wallet.balance,
      calculatedBalance,
      difference,
      consistent: difference.isZero(),
      checkedEntries: entries.length,
    };
  }
}
