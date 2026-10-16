import { randomUUID } from 'node:crypto';
import { TEST_DATABASE_URL } from './harness';
import { SQS_ENDPOINT } from './sqs';

export interface AppProcess {
  port: number;
  proc: ReturnType<typeof Bun.spawn>;
  logs: string[];
  exited: Promise<number>;
  url(path: string): string;
  stop(signal?: NodeJS.Signals): Promise<number>;
}

let nextPort = 3100 + Math.floor(Math.random() * 400);

/** Sobe `bun run src/main.ts` como PROCESSO REAL (não é mock nem thread). */
export async function spawnApp(env: Record<string, string>, opts: { waitReady?: boolean } = {}): Promise<AppProcess> {
  const port = nextPort++;
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PORT: String(port),
      DATABASE_URL: TEST_DATABASE_URL,
      DB_POOL_MAX: '10',
      AWS_ENDPOINT_URL: SQS_ENDPOINT,
      LOG_LEVEL: 'info',
      SQS_VISIBILITY_TIMEOUT_S: '3',
      SQS_WAIT_TIME_S: '1',
      SQS_RETRY_BASE_S: '1',
      SQS_RETRY_CAP_S: '2',
      OUTBOX_POLL_INTERVAL_MS: '200',
      REFERENCE_POLL_INTERVAL_MS: '300',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const logs: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream) logs.push(dec.decode(chunk));
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);
  const exited = proc.exited as Promise<number>;

  const app: AppProcess = {
    port, proc, logs, exited,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    async stop(signal = 'SIGTERM') {
      if (proc.exitCode === null) proc.kill(signal === 'SIGKILL' ? 9 : 15);
      return exited;
    },
  };
  if (opts.waitReady !== false) await waitUntilReady(app);
  return app;
}

async function waitUntilReady(app: AppProcess, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (app.proc.exitCode !== null) throw new Error(`app exited early (${app.proc.exitCode}):\n${app.logs.join('')}`);
    try {
      const res = await fetch(app.url('/health/ready'));
      if (res.ok) return;
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`app not ready in ${timeoutMs}ms:\n${app.logs.join('')}`);
}

export function queueEnv(prefix: string): Record<string, string> {
  return {
    SQS_WAGER_QUEUE: `${prefix}-wager.fifo`,
    SQS_WAGER_DLQ: `${prefix}-dlq.fifo`,
    SQS_EVENTS_QUEUE: `${prefix}-events.fifo`,
  };
}

export const uuid = () => randomUUID();

export async function httpJson(url: string, init: { method?: string; body?: unknown; key?: string } = {}) {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.key ? { 'idempotency-key': init.key } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
