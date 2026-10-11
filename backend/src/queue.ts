import { createClient } from 'redis';

// Single backend replica only: local workers are supported, but startup recovery
// must not run beside another replica. Delivery is at least once; persistent
// suggestion state is the source of truth and must make handlers idempotent.
type RedisClient = ReturnType<typeof createClient>;
type WorkerOptions = { retryAttempts?: number; retryBaseMs?: number; retryMaxMs?: number };
type Worker = { client: RedisClient; running: boolean };
type Runtime = { stopping: boolean; recovered: boolean; active: Set<string>; workers: Worker[];
  tasks: Promise<void>[]; control: RedisClient; retryAttempts: number; retryBaseMs: number; retryMaxMs: number };
const LEASE_SECONDS = 300;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let producer: RedisClient | null = null;
let runtime: Runtime | null = null;
let closing: Promise<void> | null = null;
const lastLog = new Map<string, number>();

function keys() {
  const prefix = process.env.QUEUE_KEY_PREFIX?.trim() || 'translation';
  const queue = `${prefix}:pretranslate`;
  return { queue, processing: `${queue}:processing`, delayed: `${queue}:delayed`,
    attempts: `${queue}:attempts`, dead: `${queue}:dead`, dedupe: `${queue}:dedupe:` };
}
function redisUrl(): string | null { return process.env.REDIS_URL?.trim() || null; }
function logUnavailable(role: string): void {
  const now = Date.now();
  if (now - (lastLog.get(role) || 0) < 10_000) return;
  lastLog.set(role, now);
  // Raw Redis errors may contain connection URLs or credentials.
  console.error(role === 'job handler'
    ? 'pretranslate handler failed; bounded retry or dead letter recorded'
    : `pretranslate queue ${role} unavailable; reconnecting`);
}
function makeClient(url: string, role: string): RedisClient {
  const client = createClient({ url, name: `${keys().queue}:${role}`, disableOfflineQueue: true, socket: {
    connectTimeout: 5000,
    reconnectStrategy: (attempt) => Math.min(250 * 2 ** Math.min(attempt, 4), 3000),
  } });
  client.on('error', () => logUnavailable(role));
  return client;
}
function ensureConnected(client: RedisClient, role: string): void {
  if (!client.isOpen) void client.connect().catch(() => logUnavailable(role));
}
function ensureProducer(): RedisClient | null {
  const url = redisUrl();
  if (!url || closing) return null;
  producer ||= makeClient(url, 'control');
  ensureConnected(producer, 'control');
  return producer;
}
async function connectProducer(): Promise<RedisClient | null> {
  const client = ensureProducer();
  if (!client) return null;
  const deadline = Date.now() + 5000;
  while (!client.isReady && Date.now() < deadline && !closing) await sleep(50);
  if (!client.isReady || closing) throw new Error('Pretranslation queue is unavailable');
  return client;
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback;
}

// Membership checks also prevent duplicates when a waiting job outlives its lease.
const ENQUEUE = `
if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
if redis.call('LPOS', KEYS[1], ARGV[1]) or redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  redis.call('SET', KEYS[4], 'queued', 'EX', ARGV[2]); return 0
end
-- Missing processing lease means an abandoned reservation; do not renew it
-- indefinitely when the persistent scheduler retries this sentence.
redis.call('LREM', KEYS[2], 0, ARGV[1])
redis.call('SET', KEYS[4], 'queued', 'EX', ARGV[2])
redis.call('LPUSH', KEYS[1], ARGV[1])
return 1`;
const ACK = `
redis.call('LREM', KEYS[1], 1, ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('HDEL', KEYS[3], ARGV[1])
return 1`;
const FAIL = `
local attempt = redis.call('HINCRBY', KEYS[3], ARGV[1], 1)
redis.call('LREM', KEYS[1], 1, ARGV[1])
if attempt < tonumber(ARGV[2]) then
  local delay = math.min(tonumber(ARGV[4]), tonumber(ARGV[3]) * (2 ^ (attempt - 1)))
  redis.call('ZADD', KEYS[2], tonumber(ARGV[5]) + delay, ARGV[1])
  redis.call('SET', KEYS[4], 'retrying', 'EX', ARGV[6])
else
  redis.call('LPUSH', KEYS[5], ARGV[1]); redis.call('LTRIM', KEYS[5], 0, 999)
  redis.call('DEL', KEYS[4]); redis.call('HDEL', KEYS[3], ARGV[1])
end
return attempt`;
// Every move is atomic. Never DEL processing before replacing its jobs.
const RECOVER = `
local count = redis.call('LLEN', KEYS[2])
for i = 1, count do
  local id = redis.call('LPOP', KEYS[2])
  if not redis.call('LPOS', KEYS[1], id) and not redis.call('ZSCORE', KEYS[3], id) then redis.call('RPUSH', KEYS[1], id) end
  redis.call('SET', ARGV[1] .. id, 'queued', 'EX', ARGV[2])
end
return count`;
const MAINTAIN = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[3], id)
  if not redis.call('LPOS', KEYS[1], id) then redis.call('LPUSH', KEYS[1], id) end
  redis.call('SET', ARGV[2] .. id, 'queued', 'EX', ARGV[3])
end
local active = {}
for i = 4, #ARGV do
  active[ARGV[i]] = true
  redis.call('SET', ARGV[2] .. ARGV[i], 'running', 'EX', ARGV[3])
end
-- Recover lost pop replies or failed acknowledgements after the lease expires.
for _, id in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
  if not active[id] and redis.call('EXISTS', ARGV[2] .. id) == 0 then
    redis.call('LREM', KEYS[2], 0, id)
    if not redis.call('LPOS', KEYS[1], id) and not redis.call('ZSCORE', KEYS[3], id) then redis.call('LPUSH', KEYS[1], id) end
    redis.call('SET', ARGV[2] .. id, 'queued', 'EX', ARGV[3])
  end
end
return #ids`;

export function queueConfigured(): boolean { return Boolean(redisUrl()); }
export function queueReady(): boolean { return !closing && Boolean(producer?.isReady); }
export function workerReady(): boolean {
  return Boolean(runtime && !runtime.stopping && runtime.recovered && runtime.control.isReady &&
    runtime.workers.some((worker) => worker.running && worker.client.isReady));
}
export async function enqueuePretranslate(sentenceId: string): Promise<boolean> {
  const client = await connectProducer();
  if (!client) return false;
  const k = keys();
  try {
    await client.eval(ENQUEUE, { keys: [k.queue, k.processing, k.delayed, `${k.dedupe}${sentenceId}`],
      arguments: [sentenceId, String(LEASE_SECONDS)] });
    return true;
  } catch { throw new Error('Pretranslation queue is unavailable'); }
}
async function maintain(state: Runtime): Promise<void> {
  const k = keys();
  while (!state.stopping) {
    try {
      ensureConnected(state.control, 'control');
      if (state.control.isReady) {
        if (!state.recovered) {
          await state.control.eval(RECOVER, { keys: [k.queue, k.processing, k.delayed], arguments: [k.dedupe, String(LEASE_SECONDS)] });
          state.recovered = true;
        }
        await state.control.eval(MAINTAIN, { keys: [k.queue, k.processing, k.delayed],
          arguments: [String(Date.now()), k.dedupe, String(LEASE_SECONDS), ...state.active] });
      }
    } catch { logUnavailable('maintenance'); }
    await sleep(250);
  }
}
async function runWorker(state: Runtime, worker: Worker, handler: (sentenceId: string) => Promise<void>): Promise<void> {
  const k = keys();
  worker.running = true;
  try {
    while (!state.stopping) {
      try {
        ensureConnected(worker.client, 'worker');
        if (!state.recovered || !state.control.isReady || !worker.client.isReady) { await sleep(250); continue; }
        // LPUSH + BRPOPLPUSH is FIFO. Only this connection blocks; all business
        // operations use control. A finite timeout also bounds idle waiting.
        const sentenceId = await worker.client.brPopLPush(k.queue, k.processing, 1);
        if (!sentenceId || state.stopping) continue;
        state.active.add(sentenceId);
        try {
          await state.control.set(`${k.dedupe}${sentenceId}`, 'running', { EX: LEASE_SECONDS });
          await handler(sentenceId);
          if (!state.stopping) await state.control.eval(ACK, { keys: [k.processing, `${k.dedupe}${sentenceId}`, k.attempts], arguments: [sentenceId] });
        } catch {
          if (!state.stopping && state.control.isReady) {
            await state.control.eval(FAIL, { keys: [k.processing, k.delayed, k.attempts, `${k.dedupe}${sentenceId}`, k.dead],
              arguments: [sentenceId, String(state.retryAttempts), String(state.retryBaseMs), String(state.retryMaxMs), String(Date.now()), String(LEASE_SECONDS)] });
            logUnavailable('job handler');
          }
          // On Redis failure leave processing intact for lease recovery.
        } finally { state.active.delete(sentenceId); }
      } catch {
        if (!state.stopping) { logUnavailable('worker'); await sleep(500); }
      }
    }
  } finally { worker.running = false; }
}
export async function startPretranslateWorker(handler: (sentenceId: string) => Promise<void>, options: WorkerOptions = {}): Promise<void> {
  if (closing) await closing;
  const url = redisUrl();
  if (!url || runtime) return;
  const control = ensureProducer();
  if (!control) return;
  const count = bounded(Number(process.env.PRETRANSLATE_WORKERS || 2), 2, 1, 8);
  const state: Runtime = { stopping: false, recovered: false, active: new Set(), control, tasks: [],
    workers: Array.from({ length: count }, () => ({ client: makeClient(url, 'worker'), running: false })),
    retryAttempts: bounded(options.retryAttempts, 3, 1, 10), retryBaseMs: bounded(options.retryBaseMs, 1000, 100, 60_000),
    retryMaxMs: bounded(options.retryMaxMs, 30_000, 100, 60_000) };
  runtime = state;
  // Boot during an outage is allowed: reconnect loops continue and readiness
  // remains false until recovery and worker connections actually succeed.
  state.tasks = [maintain(state), ...state.workers.map((worker) => runWorker(state, worker, handler))];
}
export async function getQueueMetrics(): Promise<{ ready: boolean; workersReady: number; waiting: number | null; processing: number | null; delayed: number | null; deadLetter: number | null }> {
  const result = { ready: queueReady(), workersReady: workerReady() ? runtime!.workers.filter((w) => w.running && w.client.isReady).length : 0,
    waiting: null as number | null, processing: null as number | null, delayed: null as number | null, deadLetter: null as number | null };
  const client = producer;
  if (!result.ready || !client) return result;
  const k = keys();
  try {
    const [waiting, processing, delayed, deadLetter] = await Promise.all([client.lLen(k.queue), client.lLen(k.processing), client.zCard(k.delayed), client.lLen(k.dead)]);
    return { ...result, waiting, processing, delayed, deadLetter };
  } catch { return { ...result, ready: false, workersReady: 0 }; }
}
export async function closeQueue(options: { timeoutMs?: number } = {}): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    const state = runtime;
    if (state) {
      state.stopping = true;
      // QUIT queues behind BRPOP. Disconnect to stop idle workers immediately.
      await Promise.all(state.workers.map(async ({ client }) => { if (client.isOpen) await client.disconnect().catch(() => undefined); }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(state.tasks), new Promise<void>((resolve) => { timer = setTimeout(resolve, bounded(options.timeoutMs, 5000, 100, 120_000)); })]);
      if (timer) clearTimeout(timer);
    }
    // Jobs beyond the shutdown deadline stay in processing for next startup.
    // Callers must stop the application after closing (handlers are not killed).
    if (producer?.isOpen) await producer.disconnect().catch(() => undefined);
    producer = null;
    runtime = null;
  })();
  try { await closing; } finally { closing = null; }
}
