import pino from 'pino';
import type { AppLogger } from '../../application/ports/ports';

/** Logs estruturados (JSON, uma linha por evento) com campos de correlação. */
export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: pino.Logger) {}

  static create(level: string): PinoAppLogger {
    return new PinoAppLogger(pino({ level, base: { service: 'wager-processor' }, timestamp: pino.stdTimeFunctions.isoTime }));
  }
  info(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.info({ event, ...fields });
  }
  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.warn({ event, ...fields });
  }
  error(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.error({ event, ...fields });
  }
}

export class SilentLogger implements AppLogger {
  readonly entries: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  info(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level: 'info', event, fields });
  }
  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level: 'warn', event, fields });
  }
  error(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level: 'error', event, fields });
  }
}
