import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** DTO — interface é adequada aqui. */
export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

// Decimal.js isolado: não altera a configuração global de quem importar o domínio.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const SCALE = 2;
/** Entrada: inteiro ou até 2 casas decimais, sem sinal, sem notação científica, até 17 dígitos inteiros (numeric(19,2)). */
const AMOUNT_INPUT = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Value Object imutável. Nunca usa `number`: toda aritmética passa por Decimal (base 10, exato).
 * Valores negativos só existem como resultado de aritmética (ex.: diferença na reconciliação);
 * `Money.from` (contrato de entrada) rejeita qualquer valor negativo.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${String(currency)}": expected 3 uppercase letters (ISO-4217)`);
    }
    if (!AMOUNT_INPUT.test(amount)) {
      throw new InvalidMoneyError(
        `invalid amount "${amount}": expected a non-negative decimal string with at most 2 decimal places`,
      );
    }
    return new Money(new D(amount).toDecimalPlaces(SCALE), currency);
  }

  /** Reconstrói a partir de uma coluna numeric(19,2) já persistida (aceita sinal). */
  static fromStored(amount: string, currency: string): Money {
    if (!/^-?\d+(\.\d+)?$/.test(amount)) {
      throw new InvalidMoneyError(`invalid stored amount "${amount}"`);
    }
    return new Money(new D(amount).toDecimalPlaces(SCALE), currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${currency}"`);
    }
    return new Money(new D(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** String decimal com exatamente 2 casas, ex.: "25.00". */
  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
