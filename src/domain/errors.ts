/** Erros de domínio. Nenhum depende de framework. */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
}

/** Mesma idempotency key (ou mesmo externalTransactionId) com payload diferente. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

/** Entrada malformada (HTTP/SQS). Permanente: reenviar o mesmo payload nunca funciona. */
export class InvalidPayloadError extends DomainError {
  readonly code = 'INVALID_PAYLOAD';
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Falha transitória de infraestrutura (DB/SQS indisponíveis, lock timeout, deadlock). Reenviar é seguro. */
export class TransientInfrastructureError extends Error {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}
