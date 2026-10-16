import {
  Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, ServiceUnavailableException,
} from '@nestjs/common';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { Request, Response } from 'express';
import { InvalidPayloadError } from '../../domain/errors';
import type { Services } from '../../composition';
import type { Runtime } from '../../runtime';
import { RUNTIME, SERVICES } from '../tokens';
import { Public } from './auth';
import { presentResult, statusForResult } from './http-errors';

type Req_ = Request & { correlationId?: string };
const corr = (req: Req_) => req.correlationId ?? 'unknown';

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: Req_) {
    const w = await this.s.createWallet.execute(body, corr(req));
    return { id: w.walletId, playerId: w.playerId, balance: w.balance, version: w.version };
  }

  @Get(':walletId')
  getWallet(@Param('walletId', new ParseUUIDPipe({ exceptionFactory: () => new InvalidPayloadError('walletId must be a UUID') })) id: string) {
    return this.s.queries.getWallet(id);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', new ParseUUIDPipe({ exceptionFactory: () => new InvalidPayloadError('walletId must be a UUID') })) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new InvalidPayloadError('limit must be an integer between 1 and 200');
    return this.s.queries.getLedger(id, cursor, n);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', new ParseUUIDPipe({ exceptionFactory: () => new InvalidPayloadError('walletId must be a UUID') })) id: string) {
    return this.s.queries.reconcile(id);
  }
}

@Controller()
export class WageringController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Post('wagering/transactions')
  async submit(@Body() body: unknown, @Req() req: Req_, @Res({ passthrough: true }) res: Response) {
    const key = req.header('idempotency-key');
    if (!key) throw new InvalidPayloadError('Idempotency-Key header is required', [{ path: 'Idempotency-Key', message: 'required' }]);
    const result = await this.s.processWager.execute(body, key, { correlationId: corr(req), source: 'http' });
    res.status(statusForResult(result));
    return presentResult(result);
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId', new ParseUUIDPipe({ exceptionFactory: () => new InvalidPayloadError('transactionId must be a UUID') })) id: string) {
    return this.s.queries.getTransaction(id);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    return this.s.queries.getTransactionByExternal(providerId, externalId);
  }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(SERVICES) private readonly s: Services,
    @Inject(RUNTIME) private readonly runtime: Runtime,
  ) {}

  /** Liveness: o processo responde. Não toca em dependências (senão o orquestrador reinicia por falha do banco). */
  @Public()
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. */
  @Public()
  @Get('health/ready')
  async ready() {
    const checks: Record<string, 'up' | 'down'> = { postgres: 'down', sqs: 'down' };
    await this.s.reads.ping().then(() => { checks.postgres = 'up'; }).catch(() => undefined);
    await this.runtime.sqs.client
      .send(new GetQueueAttributesCommand({ QueueUrl: this.runtime.sqs.urls.wager, AttributeNames: ['QueueArn'] }))
      .then(() => { checks.sqs = 'up'; })
      .catch(() => undefined);
    const ok = Object.values(checks).every((v) => v === 'up');
    if (!ok) throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ok', checks };
  }

  @Public()
  @Get('metrics')
  async metrics(@Res() res: Response) {
    if (!this.s.prom) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', this.s.prom.registry.contentType);
    res.send(await this.s.prom.registry.metrics());
  }
}
