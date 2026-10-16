import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../domain/errors';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { FailureCode, retryAdvice } from '../../domain/failure-code';
import type { WagerResult } from '../../application/use-cases/process-wager-transaction';
import type { AppLogger } from '../../application/ports/ports';

/**
 * Mapeamento ÚNICO e consistente (vale para todos os endpoints). O provedor decide reenviar só pelo status:
 *
 *  400 INVALID_PAYLOAD                  reenviar o MESMO payload nunca funciona — corrigir.
 *  404 *_NOT_FOUND                      recurso inexistente.
 *  409 IDEMPOTENCY_CONFLICT / WALLET_ALREADY_EXISTS   conflito — não é replay.
 *  422 status=REJECTED                  regra de negócio; terminal; mesma key devolve a mesma rejeição.
 *  202 status=PENDING_REFERENCE         aceito; aguardando a transação referenciada (resultado vem depois).
 *  201 PROCESSED (novo) / 200 PROCESSED (replay)
 *  503 TRANSIENT_INFRASTRUCTURE_ERROR   nada foi aplicado; reenviar a MESMA requisição com a MESMA key é seguro.
 *  500 INTERNAL_ERROR                   bug inesperado (e FAILED).
 */
export function statusForResult(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

export function presentResult(result: WagerResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    ...(result.balance ? { balance: result.balance } : {}),
    ...(result.failureCode
      ? { failureCode: result.failureCode, retryAdvice: retryAdvice[result.failureCode as FailureCode] }
      : {}),
    idempotentReplay: result.idempotentReplay,
  };
}

interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; correlationId?: string; details?: unknown };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const correlationId = (req as Request & { correlationId?: string }).correlationId;
    const { status, body, headers } = this.translate(exception, correlationId);
    if (status >= 500) {
      this.logger.error('http.error', {
        correlationId,
        method: req.method,
        path: req.path,
        status,
        code: body.error.code,
        error: exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception),
      });
    }
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).json(body);
  }

  private translate(
    e: unknown,
    correlationId?: string,
  ): { status: number; body: ErrorBody; headers: Record<string, string> } {
    const make = (status: number, code: string, message: string, retryable: boolean, details?: unknown, headers = {}) => ({
      status,
      headers,
      body: { error: { code, message, retryable, ...(correlationId ? { correlationId } : {}), ...(details !== undefined ? { details } : {}) } },
    });

    if (e instanceof InvalidPayloadError) return make(400, 'INVALID_PAYLOAD', e.message, false, e.details);
    if (e instanceof IdempotencyConflictError) return make(409, 'IDEMPOTENCY_CONFLICT', e.message, false);
    if (e instanceof WalletAlreadyExistsError) return make(409, 'WALLET_ALREADY_EXISTS', e.message, false);
    if (e instanceof WalletNotFoundError) return make(404, 'WALLET_NOT_FOUND', e.message, false);
    if (e instanceof TransactionNotFoundError) return make(404, 'TRANSACTION_NOT_FOUND', e.message, false);
    if (e instanceof TransientInfrastructureError) {
      return make(503, 'TRANSIENT_INFRASTRUCTURE_ERROR', 'temporary failure; retry the same request with the same Idempotency-Key', true, undefined, { 'Retry-After': '1' });
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const code = status === 404 ? 'NOT_FOUND' : status === 400 || status === 413 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
      return make(status, code, status === 400 ? 'malformed request' : e.message, false);
    }
    return make(500, 'INTERNAL_ERROR', 'unexpected error', false);
  }
}
