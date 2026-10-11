import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { createClient } from 'redis';
import { closeQueue, enqueuePretranslate, getQueueMetrics, queueReady, startPretranslateWorker, workerReady } from './queue.js';

// Uses an isolated real Redis container by default. An existing Redis is allowed
// via QUEUE_TEST_REDIS_URL; only keys with this run's random prefix are touched.
const prefix = `translation-queue-test-${randomBytes(8).toString('hex')}`;
const queue = `${prefix}:pretranslate`;
const saved = { url: process.env.REDIS_URL, prefix: process.env.QUEUE_KEY_PREFIX, workers: process.env.PRETRANSLATE_WORKERS };
let container: string | undefined;
let admin: ReturnType<typeof createClient> | undefined;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(20); }
  throw new Error(`Timed out: ${message}`);
}
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

try {
  let url = process.env.QUEUE_TEST_REDIS_URL;
  if (!url) {
    container = prefix;
    const password = randomBytes(24).toString('hex');
    const image = process.env.QUEUE_TEST_REDIS_IMAGE || 'crpi-niexz8xjgx5cs0ez.cn-guangzhou.personal.cr.aliyuncs.com/zhongkangdemo/translation_platform:redis-7-alpine-0.1.7';
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    // Keep the chosen port stable across docker stop/start for outage testing.
    docker('run', '-d', '--pull', 'never', '--name', container, '-p', `127.0.0.1:${port}:6379`, image,
      'redis-server', '--save', '', '--appendonly', 'no', '--requirepass', password);
    const endpoint = docker('port', container, '6379/tcp').split('\n')[0];
    url = `redis://:${password}@${endpoint}`;
  }
  process.env.REDIS_URL = url;
  process.env.QUEUE_KEY_PREFIX = prefix;
  process.env.PRETRANSLATE_WORKERS = '1';
  admin = createClient({ url });
  admin.on('error', () => undefined);
  await admin.connect();

  // Concurrent producers and expired waiting leases must not duplicate a job.
  assert.equal(await enqueuePretranslate('first'), true);
  await enqueuePretranslate('second');
  await enqueuePretranslate('third');
  await Promise.all(Array.from({ length: 20 }, () => enqueuePretranslate('first')));
  await admin.del(`${queue}:dedupe:first`);
  await enqueuePretranslate('first');
  assert.equal(await admin.lLen(queue), 3);
  const order: string[] = [];
  await startPretranslateWorker(async (id) => { order.push(id); });
  await until(async () => order.length === 3 && (await getQueueMetrics()).processing === 0, 'FIFO completion');
  assert.deepEqual(order, ['first', 'second', 'third']);
  assert.equal(workerReady(), true);
  assert.equal(queueReady(), true);
  await closeQueue();

  // Unexpected handler failures get bounded delayed retries, never a hot loop.
  const attempts: number[] = [];
  let healthyDuringRetry = false;
  await startPretranslateWorker(async (id) => {
    if (id === 'healthy-during-retry') { healthyDuringRetry = true; return; }
    attempts.push(Date.now()); throw new Error('deliberate test failure');
  },
    { retryAttempts: 3, retryBaseMs: 300, retryMaxMs: 600 });
  await enqueuePretranslate('fails');
  await until(async () => attempts.length === 1 && (await getQueueMetrics()).delayed === 1, 'first delayed retry');
  await Promise.all(Array.from({ length: 20 }, () => enqueuePretranslate('fails')));
  await enqueuePretranslate('healthy-during-retry');
  await until(() => healthyDuringRetry, 'healthy job is not blocked by retry delay');
  await until(async () => (await getQueueMetrics()).deadLetter === 1, 'bounded dead letter');
  await sleep(800);
  assert.equal(attempts.length, 3);
  assert.ok(attempts[1] - attempts[0] >= 280, 'first backoff');
  assert.ok(attempts[2] - attempts[1] >= 580, 'second backoff');
  await closeQueue();

  // Legacy processing jobs and durable delayed jobs survive a worker restart.
  await admin.lPush(`${queue}:processing`, ['stranded-oldest', 'stranded-newer']);
  await admin.lPush(queue, 'still-pending');
  await admin.zAdd(`${queue}:delayed`, { score: Date.now() + 600, value: 'delayed-survivor' });
  const recovered: string[] = [];
  await startPretranslateWorker(async (id) => { recovered.push(id); });
  await until(() => recovered.length === 4, 'startup and delayed recovery');
  assert.deepEqual(recovered, ['stranded-oldest', 'stranded-newer', 'still-pending', 'delayed-survivor']);

  // Simulate a pop reply lost on a disconnected socket. An expired reservation
  // is recovered during normal operation without restarting the backend.
  await admin.lPush(`${queue}:processing`, 'lost-reply');
  await admin.set(`${queue}:dedupe:lost-reply`, 'queued', { PX: 100 });
  await until(() => recovered.includes('lost-reply'), 'runtime reservation recovery');

  // Kill only this test's queue connections. The live loops must reconnect and
  // keep processing instead of claiming readiness forever or silently exiting.
  const listing = String(await admin.sendCommand(['CLIENT', 'LIST']));
  const clientIds = listing.split('\n').filter((line) => line.includes(`name=${queue}:`))
    .map((line) => /^id=(\d+)/.exec(line)?.[1]).filter((id): id is string => Boolean(id));
  assert.equal(clientIds.length, 2);
  await Promise.all(clientIds.map((id) => admin!.sendCommand(['CLIENT', 'KILL', 'ID', id])));
  // An immediate reconnect can finish before the test samples readiness. Make
  // a sustained outage only on our own container, never on a provided server.
  if (container) {
    docker('stop', '-t', '0', container);
    await until(() => !workerReady() && !queueReady(), 'readiness reflects outage');
    docker('start', container);
    await until(() => Boolean(admin?.isReady), 'admin reconnect');
  }
  await until(() => workerReady() && queueReady(), 'connection recovery');
  await enqueuePretranslate('after-reconnect');
  await until(() => recovered.includes('after-reconnect'), 'processing after reconnect');
  const closedAt = Date.now();
  await closeQueue({ timeoutMs: 1000 });
  assert.ok(Date.now() - closedAt < 1500, 'idle shutdown must not wait behind a blocking pop');
  assert.equal(queueReady(), false);
  assert.equal(workerReady(), false);

  // An outage at boot must expose false readiness and still shut down promptly.
  process.env.REDIS_URL = 'redis://127.0.0.1:1';
  await startPretranslateWorker(async () => undefined);
  await sleep(100);
  assert.equal(queueReady(), false);
  assert.equal(workerReady(), false);
  const outageCloseAt = Date.now();
  await closeQueue({ timeoutMs: 1000 });
  assert.ok(Date.now() - outageCloseAt < 1500, 'outage shutdown');
  console.log(JSON.stringify({ queueTests: 'passed', checks: ['FIFO', 'atomic deduplication', 'expired lease deduplication',
    'bounded delayed retries', 'restart recovery', 'lost reply recovery', 'connection readiness and recovery', 'bounded shutdown', 'boot outage'] }));
} finally {
  await closeQueue({ timeoutMs: 1000 });
  if (admin?.isReady) {
    const keys: string[] = [];
    for await (const key of admin.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) keys.push(key);
    if (keys.length) await admin.del(keys);
  }
  if (admin?.isOpen) await admin.disconnect();
  if (container) docker('rm', '-f', container);
  if (saved.url === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved.url;
  if (saved.prefix === undefined) delete process.env.QUEUE_KEY_PREFIX; else process.env.QUEUE_KEY_PREFIX = saved.prefix;
  if (saved.workers === undefined) delete process.env.PRETRANSLATE_WORKERS; else process.env.PRETRANSLATE_WORKERS = saved.workers;
}
