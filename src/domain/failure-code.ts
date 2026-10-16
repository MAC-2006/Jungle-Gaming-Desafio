/**
 * Taxonomia estável e legível por máquina para REJECTED / FAILED.
 * Cada código informa ao provedor o que fazer (ver `retryAdvice`).
 */
export enum FailureCode {
  /** BET sem saldo suficiente. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão (REFUND/ROLLBACK) que deixaria o saldo negativo. Distinto de INSUFFICIENT_FUNDS. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Referência nunca apareceu dentro do limite de tentativas/TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe mas terminou REJECTED/FAILED: não há o que reverter. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência de outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo de referência inválido (ex.: REFUND de um WIN). */
  ReferenceKindInvalid = 'REFERENCE_KIND_INVALID',
  /** Valor da reversão diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** A referência já foi revertida. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId da operação diferente do dono da wallet. */
  PlayerMismatch = 'PLAYER_MISMATCH',
  /** Erro permanente de infraestrutura (estado FAILED). */
  InternalError = 'INTERNAL_ERROR',
}

export type RetryAdvice = 'FIX_PAYLOAD' | 'DO_NOT_RETRY' | 'RETRY_WITH_NEW_TRANSACTION' | 'CONTACT_SUPPORT';

/**
 * O que o provedor deve fazer ao receber o código.
 * Reenviar a MESMA transação (mesma key) devolve sempre o mesmo resultado terminal,
 * por isso "retry" aqui significa criar uma nova transação, quando o contexto mudar.
 */
export const retryAdvice: Record<FailureCode, RetryAdvice> = {
  [FailureCode.InsufficientFunds]: 'RETRY_WITH_NEW_TRANSACTION',
  [FailureCode.ReversalInsufficientFunds]: 'CONTACT_SUPPORT',
  [FailureCode.ReferenceNotFound]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotProcessed]: 'DO_NOT_RETRY',
  [FailureCode.ReferenceMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceKindInvalid]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceAmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.AlreadyReversed]: 'DO_NOT_RETRY',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.PlayerMismatch]: 'FIX_PAYLOAD',
  [FailureCode.InternalError]: 'CONTACT_SUPPORT',
};
