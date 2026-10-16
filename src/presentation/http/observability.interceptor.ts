import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { SERVICES } from '../tokens';
import type { Services } from '../../composition';

/** Correlation id (entrada ou gerado) + log estruturado por requisição, SEM corpo nem valores financeiros. */
@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  constructor(@Inject(SERVICES) private readonly services: Services) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { correlationId?: string }>();
    const res = http.getResponse<Response>();
    const header = req.header('x-correlation-id');
    req.correlationId = header && header.length <= 200 ? header : randomUUID();
    res.setHeader('X-Correlation-Id', req.correlationId);
    const started = process.hrtime.bigint();

    const done = () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.services.metrics.processingSeconds('http', seconds);
      this.services.logger.info('http.request', {
        correlationId: req.correlationId,
        method: req.method,
        path: req.route?.path ?? req.path,
        status: res.statusCode,
        durationMs: Math.round(seconds * 1000),
        walletId: typeof req.params?.walletId === 'string' ? req.params.walletId : undefined,
      });
    };
    res.once('finish', done); // status final (inclui o que o filtro de exceções definiu)
    return next.handle();
  }
}
