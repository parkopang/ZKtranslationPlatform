import { parentPort, workerData } from 'node:worker_threads';
import mysql, { type Connection } from 'mysql2/promise';

type Request = { id: number; op: string; sql?: string; params?: unknown[]; shared: SharedArrayBuffer };
type Options = { host: string; port: number; database: string; user: string; password: string; connectTimeout?: number; ssl?: boolean };

let connection: Connection | undefined;
let connecting: Promise<Connection> | undefined;

async function getConnection(): Promise<Connection> {
  if (connection) return connection;
  connecting ||= mysql.createConnection({
    host: (workerData as Options).host,
    port: (workerData as Options).port,
    database: (workerData as Options).database,
    user: (workerData as Options).user,
    password: (workerData as Options).password,
    connectTimeout: (workerData as Options).connectTimeout,
    ssl: (workerData as Options).ssl ? { minVersion: 'TLSv1.2' } : undefined,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: true,
  });
  const connected = await connecting;
  // SQLite stores all application timestamps as UTC ISO strings. Pin the
  // MySQL session to UTC so CURRENT_TIMESTAMP and DATETIME comparisons do not
  // shift by the server's local timezone (for example Asia/Shanghai).
  await connected.query("SET time_zone = '+00:00'");
  connection = connected;
  connecting = undefined;
  return connection;
}

function serializable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => {
    if (typeof nested === 'bigint') return Number(nested);
    if (nested instanceof Date) return nested.toISOString();
    return nested;
  }));
}

function write(shared: SharedArrayBuffer, response: unknown): void {
  const state = new Int32Array(shared, 0, 2);
  const target = new Uint8Array(shared, 8);
  const bytes = new TextEncoder().encode(JSON.stringify(response));
  if (bytes.length > target.byteLength) {
    const fallback = new TextEncoder().encode(JSON.stringify({ ok: false, error: { message: 'mysql_response_too_large', code: 'ER_RESPONSE_TOO_LARGE' } }));
    target.set(fallback.subarray(0, target.byteLength));
    Atomics.store(state, 1, Math.min(fallback.length, target.byteLength));
  } else {
    target.set(bytes);
    Atomics.store(state, 1, bytes.length);
  }
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}

async function handle(request: Request): Promise<void> {
  try {
    const db = await getConnection();
    let result: unknown;
    if (request.op === 'query') [result] = await db.query(request.sql || '', request.params || []);
    else if (request.op === 'exec') [result] = await db.query(request.sql || '');
    else if (request.op === 'begin') result = await db.beginTransaction();
    else if (request.op === 'commit') result = await db.commit();
    else if (request.op === 'rollback') result = await db.rollback();
    else if (request.op === 'close') { await db.end(); connection = undefined; result = true; }
    else throw Object.assign(new Error('mysql_unknown_operation'), { code: 'ER_UNKNOWN_OPERATION' });
    write(request.shared, { ok: true, result: serializable(result) });
  } catch (error) {
    const value = error as { message?: string; code?: string; errno?: number; sqlState?: string };
    write(request.shared, { ok: false, error: { message: value.message || 'mysql_query_failed', code: value.code, errno: value.errno, sqlState: value.sqlState } });
  }
}

if (!parentPort) throw new Error('mysql_worker_parent_port_missing');
let queue = Promise.resolve();
parentPort.on('message', (request: Request) => {
  queue = queue.then(() => handle(request));
});
