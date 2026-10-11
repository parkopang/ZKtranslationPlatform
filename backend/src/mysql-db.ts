import { Worker } from 'node:worker_threads';
import type { DB, DBStatement, DBTransaction } from './db.js';

const RESPONSE_BUFFER_BYTES = 16 * 1024 * 1024;
const WAIT_TIMEOUT_MS = 120_000;

type MysqlOptions = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit?: number;
  connectTimeout?: number;
  ssl?: boolean;
};

type WorkerResponse = { ok: true; result?: unknown } | { ok: false; error: { message: string; code?: string; errno?: number; sqlState?: string } };

function normalizeSql(sql: string): string {
  return sql
    .replace(/strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/gi, 'CURRENT_TIMESTAMP(3)')
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP(3)')
    .replace(/julianday\(expires_at\)\s*<=\s*julianday\(\?\)/gi, 'expires_at <= ?')
    .replace(/julianday\(expires_at\)\s*>\s*julianday\(\?\)/gi, 'expires_at > ?')
    .replace(/julianday\(expires_at\)\s*<=\s*julianday\('now'\)/gi, 'expires_at <= CURRENT_TIMESTAMP(3)')
    .replace(/julianday\(expires_at\)\s*>\s*julianday\('now'\)/gi, 'expires_at > CURRENT_TIMESTAMP(3)')
    .replace(/INSERT\s+OR\s+IGNORE/gi, 'INSERT IGNORE')
    .replace(/INSERT\s+OR\s+REPLACE/gi, 'REPLACE');
}

function numeric(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

export class MysqlDatabase implements DB {
  private readonly worker: Worker;
  private closed = false;
  private fatal: Error | undefined;
  private nextId = 1;

  constructor(options: MysqlOptions) {
    this.worker = new Worker(new URL('./mysql-worker.js', import.meta.url), {
      workerData: options,
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
    });
    this.worker.on('error', (error) => { this.fatal = error; });
    this.worker.on('exit', (code) => {
      if (code !== 0 && !this.closed) this.fatal ||= new Error(`mysql_worker_exit_${code}`);
    });
  }

  private call<T = unknown>(op: string, sql?: string, params: unknown[] = []): T {
    if (this.closed) throw new Error('database_closed');
    if (this.fatal) throw this.fatal;
    const shared = new SharedArrayBuffer(RESPONSE_BUFFER_BYTES);
    const state = new Int32Array(shared, 0, 2);
    const id = this.nextId++;
    this.worker.postMessage({ id, op, sql, params, shared });
    const status = Atomics.wait(state, 0, 0, WAIT_TIMEOUT_MS);
    if (status === 'timed-out') throw new Error('mysql_query_timeout');
    const length = Atomics.load(state, 1);
    const bytes = new Uint8Array(shared, 8, Math.max(0, Math.min(length, RESPONSE_BUFFER_BYTES - 8)));
    const response = JSON.parse(new TextDecoder().decode(bytes)) as WorkerResponse;
    if (!response.ok) {
      const error = new Error(response.error.message);
      Object.assign(error, response.error);
      throw error;
    }
    return response.result as T;
  }

  prepare(sql: string): DBStatement {
    const normalized = normalizeSql(sql);
    return {
      get: (...params: unknown[]) => {
        const rows = this.call<unknown[]>('query', normalized, params);
        return rows[0];
      },
      all: (...params: unknown[]) => this.call<unknown[]>('query', normalized, params),
      run: (...params: unknown[]) => {
        const result = this.call<{ affectedRows?: number; insertId?: number | string }>('query', normalized, params);
        return { changes: Number(result?.affectedRows || 0), lastInsertRowid: result?.insertId };
      },
    };
  }

  exec(sql: string): void {
    this.call('exec', normalizeSql(sql));
  }

  transaction<T>(fn: () => T): DBTransaction<T> {
    const invoke = () => {
      this.call('begin');
      try {
        const result = fn();
        this.call('commit');
        return result;
      } catch (error) {
        try { this.call('rollback'); } catch { /* preserve original error */ }
        throw error;
      }
    };
    const transaction = invoke as DBTransaction<T>;
    transaction.immediate = invoke;
    return transaction;
  }

  pragma(..._args: unknown[]): unknown {
    return undefined;
  }

  close(): void {
    if (this.closed) return;
    try { this.call('close'); } catch { /* worker may already have exited */ }
    this.closed = true;
    void this.worker.terminate();
  }
}

function mysqlSchema(): string {
  return `
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      name VARCHAR(500) NOT NULL,
      real_name VARCHAR(500),
      phone TEXT,
      phone_hash VARCHAR(128),
      id_number TEXT,
      bank_card_no TEXT,
      verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      verification_source VARCHAR(32) NOT NULL DEFAULT 'unverified',
      open_id VARCHAR(100) UNIQUE,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      token_hash VARCHAR(128) NOT NULL UNIQUE,
      user_id VARCHAR(36),
      role VARCHAR(20) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      revoked_at DATETIME(3),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      actor_user_id VARCHAR(36),
      actor_role VARCHAR(20) NOT NULL,
      action VARCHAR(120) NOT NULL,
      resource_type VARCHAR(80) NOT NULL,
      resource_id VARCHAR(36),
      metadata_json JSON,
      ip VARCHAR(128),
      user_agent VARCHAR(512),
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS articles (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      source_language VARCHAR(64) NOT NULL DEFAULT 'auto',
      target_language VARCHAR(64) NOT NULL DEFAULT '英文',
      task_unit VARCHAR(20) NOT NULL DEFAULT 'sentence',
      source_file_name VARCHAR(255),
      source_object_key VARCHAR(1024),
      source_sha256 VARCHAR(128),
      source_size BIGINT,
      translator_slots INT NOT NULL DEFAULT 2,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS sentences (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      article_id VARCHAR(36) NOT NULL,
      position INT NOT NULL,
      source_text LONGTEXT NOT NULL,
      translator_slots INT NOT NULL DEFAULT 2,
      translation_suggestion LONGTEXT,
      suggestion_status VARCHAR(20) NOT NULL DEFAULT 'idle',
      suggestion_error VARCHAR(255),
      suggestion_retry_at BIGINT,
      suggestion_attempts INT NOT NULL DEFAULT 0,
      suggestion_updated_at BIGINT NOT NULL DEFAULT 0,
      suggestion_provider VARCHAR(64),
      suggestion_trace_id VARCHAR(128),
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_sentences_article_position (article_id, position),
      CONSTRAINT fk_sentences_article FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS assignments (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      sentence_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'assigned',
      assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_assignments_sentence_user (sentence_id, user_id),
      CONSTRAINT fk_assignments_sentence FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE,
      CONSTRAINT fk_assignments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS translations (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      sentence_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      content LONGTEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      reviewed_at DATETIME(3),
      review_note TEXT,
      revision INT NOT NULL DEFAULT 1,
      UNIQUE KEY uq_translations_sentence_user (sentence_id, user_id),
      CONSTRAINT fk_translations_sentence FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE,
      CONSTRAINT fk_translations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS translation_versions (
      translation_id VARCHAR(36) NOT NULL,
      revision INT NOT NULL,
      content LONGTEXT NOT NULL,
      review_status VARCHAR(20) NOT NULL,
      review_note TEXT,
      submitted_at DATETIME(3) NOT NULL,
      reviewed_at DATETIME(3),
      PRIMARY KEY (translation_id, revision),
      CONSTRAINT fk_versions_translation FOREIGN KEY (translation_id) REFERENCES translations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
}

function mysqlConfigFromEnv(): MysqlOptions {
  const host = process.env.MYSQL_HOST?.trim();
  const database = process.env.MYSQL_DATABASE?.trim();
  const user = process.env.MYSQL_USER?.trim();
  const password = process.env.MYSQL_PASSWORD ?? '';
  if (!host || !database || !user) throw new Error('mysql_configuration_missing');
  return {
    host,
    port: Number(process.env.MYSQL_PORT || 3306),
    database,
    user,
    password,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 10),
    connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 10_000),
    ssl: process.env.MYSQL_SSL === 'true',
  };
}

function ensureIndex(db: MysqlDatabase, statement: string): void {
  try { db.exec(statement); } catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_KEYNAME') throw error;
  }
}

function ensureColumn(db: MysqlDatabase, table: string, column: string, definition: string): void {
  const result = db.prepare(`SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?`).get(table, column) as { count: number };
  if (!Number(result?.count)) db.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

export function createMysqlDb(): DB {
  const db = new MysqlDatabase(mysqlConfigFromEnv());
  db.exec(mysqlSchema());
  ensureColumn(db, 'users', 'verification_source', "VARCHAR(32) NOT NULL DEFAULT 'unverified'");
  ensureColumn(db, 'articles', 'source_object_key', 'VARCHAR(1024)');
  ensureColumn(db, 'articles', 'source_sha256', 'VARCHAR(128)');
  ensureColumn(db, 'articles', 'source_size', 'BIGINT');
  ensureColumn(db, 'articles', 'task_unit', "VARCHAR(20) NOT NULL DEFAULT 'sentence'");
  ensureColumn(db, 'articles', 'updated_at', 'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');
  ensureColumn(db, 'sentences', 'suggestion_status', "VARCHAR(20) NOT NULL DEFAULT 'idle'");
  ensureColumn(db, 'sentences', 'suggestion_error', 'VARCHAR(255)');
  ensureColumn(db, 'sentences', 'suggestion_retry_at', 'BIGINT');
  ensureColumn(db, 'sentences', 'suggestion_attempts', 'INT NOT NULL DEFAULT 0');
  ensureColumn(db, 'sentences', 'suggestion_updated_at', 'BIGINT NOT NULL DEFAULT 0');
  ensureColumn(db, 'sentences', 'suggestion_provider', 'VARCHAR(64)');
  ensureColumn(db, 'sentences', 'suggestion_trace_id', 'VARCHAR(128)');
  ensureColumn(db, 'translations', 'review_note', 'TEXT');
  ensureColumn(db, 'translations', 'revision', 'INT NOT NULL DEFAULT 1');
  ensureIndex(db, 'CREATE INDEX idx_sentences_article ON sentences(article_id, position)');
  ensureIndex(db, 'CREATE INDEX idx_sessions_token ON sessions(token_hash)');
  ensureIndex(db, 'CREATE INDEX idx_sessions_user ON sessions(user_id, expires_at)');
  ensureIndex(db, 'CREATE INDEX idx_audit_created ON audit_logs(created_at, id)');
  ensureIndex(db, 'CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id, created_at)');
  ensureIndex(db, 'CREATE INDEX idx_assignments_user ON assignments(user_id, status)');
  ensureIndex(db, 'CREATE INDEX idx_assignments_sentence ON assignments(sentence_id, status)');
  ensureIndex(db, 'CREATE INDEX idx_translations_status ON translations(status)');
  ensureIndex(db, 'CREATE INDEX idx_translations_sentence_status ON translations(sentence_id, status)');
  ensureIndex(db, 'CREATE UNIQUE INDEX idx_users_phone_hash_unique ON users(phone_hash)');
  ensureIndex(db, 'CREATE INDEX idx_suggestion_retry ON sentences(suggestion_status, suggestion_retry_at)');
  // Repair legacy rows without changing submitted content.
  db.exec(`UPDATE articles SET updated_at=COALESCE(updated_at, created_at) WHERE updated_at IS NULL;
    UPDATE sentences SET translation_suggestion=NULL, suggestion_status='idle' WHERE translation_suggestion='';
    UPDATE sentences SET suggestion_status='succeeded', suggestion_error=NULL, suggestion_retry_at=NULL WHERE translation_suggestion IS NOT NULL AND suggestion_status='idle';
    UPDATE assignments SET status='done' WHERE status<>'done' AND EXISTS (SELECT 1 FROM translations t WHERE t.sentence_id=assignments.sentence_id AND t.status='accepted');
    UPDATE translations AS target JOIN (SELECT sentence_id FROM translations WHERE status='accepted' GROUP BY sentence_id) AS winner ON winner.sentence_id=target.sentence_id SET target.status='rejected', target.reviewed_at=COALESCE(target.reviewed_at,CURRENT_TIMESTAMP(3)) WHERE target.status='pending';`);
  return db;
}

export { normalizeSql };
