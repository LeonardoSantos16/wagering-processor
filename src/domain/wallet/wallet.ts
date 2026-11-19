import { InvariantViolationError } from '../errors/invariant-violation.error';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { CurrencyMismatchError } from '../money/money.errors';
import { InsufficientFundsError } from './wallet.errors';

export interface WalletMovementProps {
  amount: Money;
  transactionId: string;
  entryId: string;
  now: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenWalletResult {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvariantViolationError('initial balance cannot be negative');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      props.now,
      props.now,
    );

    if (initialBalance.isZero()) {
      return { wallet };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: props.now,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  canDebit(amount: Money): boolean {
    this.assertSameCurrency(amount);
    return !this._balance.isLessThan(amount);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, props);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    if (!this.canDebit(props.amount)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  private apply(direction: LedgerDirection, props: WalletMovementProps): WalletLedgerEntry {
    const { amount } = props;
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvariantViolationError('wallet movement amount must be positive');
    }

    const balanceAfter =
      direction === LedgerDirection.Credit
        ? this._balance.add(amount)
        : this._balance.subtract(amount);

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: amount,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.now;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }
}
