import { z } from 'zod';
import { InvalidPayloadError } from '../domain/errors';
import { Money } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';

const nonEmpty = (max: number) => z.string().min(1).max(max);

const externalKinds = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

/** Contrato de entrada (HTTP e SQS). `strict`: campos desconhecidos são erro, não são ignorados em silêncio. */
export const wagerTransactionInputSchema = z
  .object({
    providerId: nonEmpty(100),
    externalTransactionId: nonEmpty(200),
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: nonEmpty(200),
    gameId: nonEmpty(200),
    kind: z.enum(externalKinds),
    money: z.object({ amount: z.string(), currency: z.string() }).strict(),
    referenceExternalTransactionId: nonEmpty(200).optional(),
  })
  .strict();

export type WagerTransactionInput = z.infer<typeof wagerTransactionInputSchema>;

export const idempotencyKeySchema = nonEmpty(300);

export const createWalletInputSchema = z
  .object({
    playerId: z.string().uuid(),
    initialBalance: z.object({ amount: z.string(), currency: z.string() }).strict(),
  })
  .strict();

export type CreateWalletInput = z.infer<typeof createWalletInputSchema>;

/** Formato de mensagem definido pelo desafio (seção 10). `data` = campos de negócio + idempotencyKey. */
export const SQS_MESSAGE_TYPE = 'WagerTransactionRequested';
export const sqsMessageSchema = z
  .object({
    messageId: nonEmpty(200),
    type: z.literal(SQS_MESSAGE_TYPE),
    occurredAt: z.string().datetime(),
    correlationId: nonEmpty(200).optional(),
    data: z.object({ idempotencyKey: idempotencyKeySchema }).passthrough(),
  })
  .strict();

export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, raw: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new InvalidPayloadError(`invalid ${what}`, result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return result.data;
}

/** Hash canônico do que identifica o pedido. Money normalizado: "25" e "25.00" são o mesmo payload. */
export function canonicalWagerPayload(input: WagerTransactionInput, money: Money): Record<string, unknown> {
  return {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: money.toJSON(),
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  };
}
