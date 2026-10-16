import type { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrentModificationError, Metrics, TransactionContext, UnitOfWork } from '../../application/ports/ports';
import { TransientInfrastructureError } from '../../domain/errors';
import { buildTransactionContext } from './pg-repositories';

/** SQLSTATEs e erros de rede em que reenviar a MESMA operação é seguro (nada foi commitado). */
const TRANSIENT_SQLSTATE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', '57P02', '57P03', // shutdown / crash / cannot_connect_now
  '53000', '53100', '53200', '53300', '53400', // recursos esgotados / too_many_connections
  '08000', '08001', '08003', '08004', '08006', '08007', // connection exceptions
]);
const TRANSIENT_NODE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const TRANSIENT_MESSAGE = /connection terminated|timeout exceeded when trying to connect|connection.*(closed|refused)|the database system is/i;
const LOCK_CONTENTION = new Set(['40001', '40P01', '55P03']);

function codeOf(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

export function translateDbError(error: unknown, metrics?: Metrics): unknown {
  if (error instanceof TransientInfrastructureError) return error;
  const code = codeOf(error);
  if (code && LOCK_CONTENTION.has(code)) metrics?.lockContention();
  if (error instanceof ConcurrentModificationError) {
    metrics?.lockContention();
    return new TransientInfrastructureError(error.message, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  if ((code && (TRANSIENT_SQLSTATE.has(code) || TRANSIENT_NODE.has(code))) || TRANSIENT_MESSAGE.test(message)) {
    return new TransientInfrastructureError(message, { cause: error });
  }
  return error;
}

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
    private readonly metrics?: Metrics,
  ) {}

  async run<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    // fork(): EntityManager (e identity map) próprio desta unidade de trabalho — nada vaza entre requisições.
    const em = this.orm.em.fork();
    const lock = Math.trunc(this.options.lockTimeoutMs);
    const stmt = Math.trunc(this.options.statementTimeoutMs);
    try {
      return await em.transactional(async (tem) => {
        // set_config(..., true) == SET LOCAL (vale só nesta transação), em UMA ida ao banco.
        await tem.execute(`SELECT set_config('lock_timeout', '${lock}', true), set_config('statement_timeout', '${stmt}', true)`);
        return fn(buildTransactionContext(tem));
      });
    } catch (error) {
      throw translateDbError(error, this.metrics);
    }
  }
}
