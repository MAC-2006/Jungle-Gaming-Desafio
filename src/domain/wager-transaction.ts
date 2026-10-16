import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

/** Provider reservado para transações internas (OPENING). Nunca aceito na API/fila. */
export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Transições válidas (qualquer outra lança InvalidTransactionStateError):
 *
 *   PENDING            -> PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *   PENDING_REFERENCE  -> PROCESSED | REJECTED | PENDING_REFERENCE (nova tentativa) | FAILED
 *   PROCESSED / REJECTED / FAILED -> (terminais, nenhuma transição)
 */
const TERMINAL = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Saldo da wallet observado quando a transação foi decidida (resposta original em replays). */
  resultBalance?: Money | undefined;
  /** Tentativas de resolver a referência (PENDING_REFERENCE). */
  referenceAttempts: number;
  nextAttemptAt?: Date | undefined;
}

export type ReferenceEvaluation =
  | { outcome: 'ok' }
  | { outcome: 'pending' }
  | { outcome: 'reject'; code: FailureCode };

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _referenceAttempts = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. Nunca aceita OPENING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError('OPENING is internal and cannot be submitted');
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    return WagerTransaction.build(props);
  }

  /** Transação interna de abertura de wallet. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    now: Date;
  }): WagerTransaction {
    const key = `opening:${props.walletId}`;
    const tx = WagerTransaction.build({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.now,
    });
    return tx;
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const kind = props.kind;
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('transaction amount must be positive');
    }
    const needsRef = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
    if (needsRef && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if (
      (kind === WagerTransactionKind.Bet || kind === WagerTransactionKind.Opening) &&
      props.referenceExternalTransactionId
    ) {
      throw new InvalidTransactionError(`${kind} must not carry a reference`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstrução a partir da persistência — NÃO revalida regras de transição. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.resultBalance,
      s.referenceAttempts,
      s.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---------------------------------------------------------------- transições
  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextAttemptAt = undefined;
  }

  /** Primeira vez ou nova tentativa: registra a tentativa e quando tentar de novo. */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertNotTerminal('markPendingReference');
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._referenceAttempts += 1;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, at: Date, resultBalance?: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  // ---------------------------------------------------------------- consultas de domínio
  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** false para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. WIN/LOSS podem referenciar uma BET, mas não exigem. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. ROLLBACK é o inverso da referência, por isso a exige.
   * Lança para LOSS (não afeta o saldo).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionError('ROLLBACK needs its reference to derive the direction');
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS does not affect the balance and has no ledger direction');
    }
  }

  /**
   * Regras 2, 3 e 5 do desafio + estado da referência.
   * `alreadyReversed` vem do banco (outra reversão PROCESSED já aponta para esta referência).
   */
  evaluateReference(reference: WagerTransaction, alreadyReversed: boolean): ReferenceEvaluation {
    if (!reference.isTerminal()) return { outcome: 'pending' };
    if (reference._status !== WagerTransactionStatus.Processed) {
      return { outcome: 'reject', code: FailureCode.ReferenceNotProcessed };
    }
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return { outcome: 'reject', code: FailureCode.ReferenceMismatch };
    }
    if (!this.allowsReferenceKind(reference.kind)) {
      return { outcome: 'reject', code: FailureCode.ReferenceKindInvalid };
    }
    if (this.requiresReference()) {
      if (!reference.money.equals(this.money)) {
        return { outcome: 'reject', code: FailureCode.ReferenceAmountMismatch };
      }
      if (alreadyReversed) {
        return { outcome: 'reject', code: FailureCode.AlreadyReversed };
      }
    }
    return { outcome: 'ok' };
  }

  private allowsReferenceKind(referenced: WagerTransactionKind): boolean {
    switch (this.kind) {
      case WagerTransactionKind.Refund:
        return referenced === WagerTransactionKind.Bet;
      case WagerTransactionKind.Rollback:
        return (
          referenced === WagerTransactionKind.Bet ||
          referenced === WagerTransactionKind.Win ||
          referenced === WagerTransactionKind.Refund
        );
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
        return referenced === WagerTransactionKind.Bet;
      default:
        return false;
    }
  }

  private assertNotTerminal(op: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${op}: transaction ${this.id} is already ${this._status}`);
    }
  }
}
