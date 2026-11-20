import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { LedgerPosition } from '../ports/wallet-ledger.repository';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface ListWalletLedgerCommand {
  walletId: string;
  after?: LedgerPosition;
  limit: number;
}

export interface WalletLedgerPage {
  entries: WalletLedgerEntry[];
  next: LedgerPosition | undefined;
}

export class ListWalletLedgerQuery {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(command: ListWalletLedgerCommand): Promise<WalletLedgerPage | null> {
    return this.unitOfWork.runReadOnly(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(command.walletId))) {
        return null;
      }
      const found = await ledger.findPage(command.walletId, command.after, command.limit + 1);
      const entries = found.slice(0, command.limit);
      const last = entries.at(-1);
      const hasMore = found.length > command.limit;
      return {
        entries,
        next: hasMore && last ? { createdAt: last.createdAt, id: last.id } : undefined,
      };
    });
  }
}
