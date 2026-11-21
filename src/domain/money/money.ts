import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

/** Non-negative integer without leading zeros, followed by exactly 2 decimal places. */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.(\d{2})$/;

/** ISO-4217 alphabetic code: exactly 3 uppercase letters. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Largest absolute amount supported, in cents: the limit of the numeric(20,2) column. */
const MAX_CENTS = 99_999_999_999_999_999_999n;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const match = typeof props.amount === 'string' ? AMOUNT_PATTERN.exec(props.amount) : null;
    if (!match) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with exactly 2 decimal places',
      );
    }
    const units = match[1] as string;
    const fraction = match[2] as string;
    return Money.of(BigInt(units) * 100n + BigInt(fraction), props.currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return Money.of(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    const sign = this.cents < 0n ? '-' : '';
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const units = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, '0');
    return { amount: `${sign}${units}.${fraction}`, currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static of(cents: bigint, currency: string): Money {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code with 3 uppercase letters');
    }
    if (cents > MAX_CENTS || cents < -MAX_CENTS) {
      throw new InvalidMoneyError('amount exceeds the maximum supported value');
    }
    return new Money(cents, currency);
  }
}
