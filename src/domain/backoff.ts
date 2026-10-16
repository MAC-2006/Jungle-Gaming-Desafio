export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
}

/** Backoff exponencial determinístico: base * 2^attempt, limitado por capMs. `attempt` começa em 0. */
export function computeBackoffMs(attempt: number, policy: BackoffPolicy): number {
  const exp = Math.min(Math.max(attempt, 0), 30);
  return Math.min(policy.capMs, policy.baseMs * 2 ** exp);
}
