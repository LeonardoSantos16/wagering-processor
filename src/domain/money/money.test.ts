import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../errors/failure-code';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';
import { Money } from './money';

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

describe('Money', () => {
  describe('from', () => {
    test('accepts a decimal string with exactly 2 decimal places', () => {
      const money = Money.from({ amount: '25.00', currency: 'BRL' });

      expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    });

    test('accepts zero', () => {
      expect(Money.from({ amount: '0.00', currency: 'BRL' }).toJSON().amount).toBe('0.00');
    });

    test.each([
      ['empty string', ''],
      ['no decimal places', '25'],
      ['one decimal place', '25.5'],
      ['more than 2 decimal places', '25.001'],
      ['negative value', '-5.00'],
      ['explicit plus sign', '+5.00'],
      ['scientific notation', '1e3'],
      ['scientific notation with decimals', '1.00e3'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['leading zeros', '01.00'],
      ['missing integer part', '.50'],
      ['surrounding whitespace', ' 25.00 '],
      ['comma as decimal separator', '25,00'],
      ['thousands separator', '1,000.00'],
      ['letters', 'abc'],
    ])('rejects %s (%p)', (_, amount) => {
      const error = captureError(() => Money.from({ amount, currency: 'BRL' }));

      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect((error as InvalidMoneyError).code).toBe(FailureCode.InvalidMoney);
    });

    test('accepts the maximum supported amount', () => {
      const money = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });

      expect(money.toJSON().amount).toBe('999999999999999999.99');
    });

    test('rejects an amount above the maximum supported', () => {
      expect(() => Money.from({ amount: '1000000000000000000.00', currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    test.each([
      ['empty string', ''],
      ['lowercase', 'brl'],
      ['mixed case', 'Brl'],
      ['two letters', 'BR'],
      ['four letters', 'BRLL'],
      ['digits', '986'],
      ['surrounding whitespace', ' BRL'],
    ])('rejects currency with %s (%p)', (_, currency) => {
      const error = captureError(() => Money.from({ amount: '25.00', currency }));

      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect((error as InvalidMoneyError).code).toBe(FailureCode.InvalidMoney);
    });

    test('rejects a non-string amount', () => {
      const amount = 25 as unknown as string;

      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });

  describe('zero', () => {
    test('creates a zero amount in the given currency', () => {
      expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
    });

    test('rejects an invalid currency', () => {
      expect(() => Money.zero('usd')).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    test('adds exactly, without floating point errors', () => {
      const result = brl('0.10').add(brl('0.20'));

      expect(result.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    });

    test('subtracts exactly', () => {
      expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    });

    test('subtraction can produce a negative amount', () => {
      expect(brl('20.00').subtract(brl('75.50')).toJSON().amount).toBe('-55.50');
    });

    test('negates an amount', () => {
      expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
      expect(brl('25.00').negate().negate().toJSON().amount).toBe('25.00');
    });

    test('negating zero keeps zero', () => {
      expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    });

    test('formats negative amounts below one unit with a leading minus sign', () => {
      expect(brl('0.00').subtract(brl('0.05')).toJSON().amount).toBe('-0.05');
    });

    test('operations return new instances and never mutate the operands', () => {
      const a = brl('10.00');
      const b = brl('3.00');

      const sum = a.add(b);
      const difference = a.subtract(b);
      const negated = a.negate();

      expect(a.toJSON().amount).toBe('10.00');
      expect(b.toJSON().amount).toBe('3.00');
      expect(sum).not.toBe(a);
      expect(difference).not.toBe(a);
      expect(negated).not.toBe(a);
    });
  });

  describe('currency conflicts', () => {
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    test.each([
      ['add', (a: Money, b: Money) => a.add(b)],
      ['subtract', (a: Money, b: Money) => a.subtract(b)],
      ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ])('%s between different currencies throws CurrencyMismatchError', (_, operation) => {
      const error = captureError(() => operation(brl('10.00'), usd));

      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).code).toBe(FailureCode.CurrencyMismatch);
    });
  });

  describe('range on operations', () => {
    test('adding beyond the maximum supported value throws InvalidMoneyError', () => {
      const max = brl('999999999999999999.99');

      expect(() => max.add(brl('0.01'))).toThrow(InvalidMoneyError);
    });

    test('subtracting beyond the negative maximum throws InvalidMoneyError', () => {
      const negativeMax = brl('999999999999999999.99').negate();

      expect(() => negativeMax.subtract(brl('0.01'))).toThrow(InvalidMoneyError);
    });
  });

  describe('serialization', () => {
    test('toString formats amount and currency for logs and messages', () => {
      expect(brl('25.00').toString()).toBe('25.00 BRL');
      expect(brl('25.00').negate().toString()).toBe('-25.00 BRL');
    });

    test('JSON.stringify produces the contract format', () => {
      expect(JSON.stringify({ money: brl('1000.00') })).toBe(
        '{"money":{"amount":"1000.00","currency":"BRL"}}',
      );
    });

    test('round-trips through toJSON and from', () => {
      const original = brl('975.40');

      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    });
  });

  describe('predicates', () => {
    test('isZero', () => {
      expect(brl('0.00').isZero()).toBe(true);
      expect(brl('0.01').isZero()).toBe(false);
    });

    test('isPositive', () => {
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('0.01').negate().isPositive()).toBe(false);
    });

    test('isNegative', () => {
      expect(brl('0.01').negate().isNegative()).toBe(true);
      expect(brl('0.00').isNegative()).toBe(false);
      expect(brl('0.01').isNegative()).toBe(false);
    });

    test('isLessThan', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
      expect(brl('80.01').isLessThan(brl('80.00'))).toBe(false);
    });

    test('equals compares amount and currency', () => {
      expect(brl('25.00').equals(brl('25.00'))).toBe(true);
      expect(brl('25.00').equals(brl('25.01'))).toBe(false);
      expect(brl('25.00').equals(Money.from({ amount: '25.00', currency: 'USD' }))).toBe(false);
    });
  });
});
