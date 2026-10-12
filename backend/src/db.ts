import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { decryptPii, encryptPii, hashPii } from './pii.js';
import { reviewStatusSql } from './reviews.js';
import { createMysqlDb } from './mysql-db.js';

// Stable built-in entry used by existing registrations and records created
// before multi-channel entry management was introduced.
export const DEFAULT_ENTRY_ID = '00000000-0000-4000-8000-000000000001';

export interface DBStatement {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => { changes: number; lastInsertRowid?: number | string };
}
export type DBTransaction<T = unknown> = (() => T) & { immediate: () => T };
export interface DB {
  prepare: (sql: string) => DBStatement;
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => DBTransaction<T>;
  pragma: (...args: unknown[]) => unknown;
  close: () => void;
}

function createSqliteDb(dbPath: string): DB {
  const resolved = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
  if (resolved !== ':memory:') fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      real_name TEXT,
      phone TEXT,
      phone_hash TEXT,
      id_number TEXT,
      bank_card_no TEXT,
      verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected')),
      entry_id TEXT,
      open_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS entry_points (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('public_account','mini_program','web')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('translator','admin')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      metadata_json TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_language TEXT NOT NULL DEFAULT 'auto',
      target_language TEXT NOT NULL DEFAULT '英文',
      task_unit TEXT NOT NULL DEFAULT 'sentence' CHECK (task_unit IN ('sentence','paragraph','chapter')),
      source_file_name TEXT,
      source_object_key TEXT,
      source_sha256 TEXT,
      source_size INTEGER,
      translator_slots INTEGER NOT NULL DEFAULT 2 CHECK (translator_slots BETWEEN 1 AND 20),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sentences (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      source_text TEXT NOT NULL,
      translator_slots INTEGER NOT NULL DEFAULT 2 CHECK (translator_slots BETWEEN 1 AND 20),
      translation_suggestion TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(article_id, position)
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','submitted','done')),
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sentence_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS translations (
      id TEXT PRIMARY KEY,
      sentence_id TEXT NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      UNIQUE(sentence_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sentences_article ON sentences(article_id, position);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assignments_user ON assignments(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_assignments_sentence ON assignments(sentence_id, status);
    CREATE INDEX IF NOT EXISTS idx_translations_status ON translations(status);
    CREATE INDEX IF NOT EXISTS idx_translations_sentence_status ON translations(sentence_id, status);
  `);
  // Lightweight forward migrations for databases created by an earlier MVP build.
  const columns = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('real_name')) db.exec('ALTER TABLE users ADD COLUMN real_name TEXT');
  if (!columns.has('phone_hash')) db.exec('ALTER TABLE users ADD COLUMN phone_hash TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_hash_unique ON users(phone_hash) WHERE phone_hash IS NOT NULL AND phone_hash <> \'\'');
  if (!columns.has('id_number')) db.exec('ALTER TABLE users ADD COLUMN id_number TEXT');
  if (!columns.has('bank_card_no')) db.exec('ALTER TABLE users ADD COLUMN bank_card_no TEXT');
  if (!columns.has('verification_status')) db.exec("ALTER TABLE users ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending'");
  if (!columns.has('entry_id')) db.exec('ALTER TABLE users ADD COLUMN entry_id TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_entry ON users(entry_id);`);
  db.exec(`INSERT OR IGNORE INTO entry_points (id,code,name,channel,status,url) VALUES ('${DEFAULT_ENTRY_ID}','default','默认入口','web','active',NULL);`);
  db.exec(`UPDATE users SET entry_id='${DEFAULT_ENTRY_ID}' WHERE entry_id IS NULL OR entry_id='';`);
  if (!columns.has('verification_source')) {
    db.exec("ALTER TABLE users ADD COLUMN verification_source TEXT NOT NULL DEFAULT 'unverified'");
    db.exec("UPDATE users SET verification_source='manual' WHERE verification_status<>'pending'");
  }
  const articleColumns = new Set((db.prepare('PRAGMA table_info(articles)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!articleColumns.has('task_unit')) db.exec("ALTER TABLE articles ADD COLUMN task_unit TEXT NOT NULL DEFAULT 'sentence'");
  if (!articleColumns.has('source_object_key')) db.exec('ALTER TABLE articles ADD COLUMN source_object_key TEXT');
  if (!articleColumns.has('source_sha256')) db.exec('ALTER TABLE articles ADD COLUMN source_sha256 TEXT');
  if (!articleColumns.has('source_size')) db.exec('ALTER TABLE articles ADD COLUMN source_size INTEGER');
  if (!articleColumns.has('updated_at')) {
    db.exec('ALTER TABLE articles ADD COLUMN updated_at TEXT');
    db.exec('UPDATE articles SET updated_at=created_at WHERE updated_at IS NULL');
  }
  // Persist model failures independently of the translated content. All dates
  // here use epoch milliseconds so queue retries survive process restarts.
  const sentenceColumns = new Set((db.prepare('PRAGMA table_info(sentences)').all() as Array<{ name: string }>).map((column) => column.name));
  const suggestionColumns: Record<string, string> = {
    suggestion_status: "TEXT NOT NULL DEFAULT 'idle'",
    suggestion_error: 'TEXT',
    suggestion_retry_at: 'INTEGER',
    suggestion_attempts: 'INTEGER NOT NULL DEFAULT 0',
    suggestion_updated_at: 'INTEGER NOT NULL DEFAULT 0',
    suggestion_provider: 'TEXT',
    suggestion_trace_id: 'TEXT',
  };
  for (const [name, type] of Object.entries(suggestionColumns)) {
    if (!sentenceColumns.has(name)) db.exec(`ALTER TABLE sentences ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_suggestion_retry ON sentences(suggestion_status, suggestion_retry_at)');
  // Older releases saved fallback source text as if it were a successful
  // translation. Match that exact format only; preserve every real translation.
  db.exec(`UPDATE sentences SET translation_suggestion=NULL, suggestion_status='idle'
    WHERE translation_suggestion = '[' || (SELECT target_language FROM articles WHERE articles.id=sentences.article_id)
      || '预翻译] ' || source_text;
    UPDATE sentences SET translation_suggestion=NULL WHERE translation_suggestion='';
    UPDATE sentences SET suggestion_status='succeeded', suggestion_error=NULL, suggestion_retry_at=NULL
      WHERE translation_suggestion IS NOT NULL AND suggestion_status='idle';`);
  // An accepted sentence is terminal for every volunteer. Repair older databases
  // that only closed the winner's assignment or allowed a late pending submission.
  // Retain all task and translation records, including their original content.
  db.transaction(() => {
    db.exec(`UPDATE assignments SET status='done'
      WHERE status<>'done' AND EXISTS (
        SELECT 1 FROM translations t WHERE t.sentence_id=assignments.sentence_id AND t.status='accepted'
      );
      UPDATE translations SET status='rejected',reviewed_at=COALESCE(reviewed_at,datetime('now'))
      WHERE status='pending' AND EXISTS (
        SELECT 1 FROM translations winner WHERE winner.sentence_id=translations.sentence_id AND winner.status='accepted'
      );`);
  })();
  // Additive, restart-safe migration: existing submissions and timestamps are
  // preserved. Historical rejections on an open sentence become editable again.
  db.transaction(() => {
    const translationColumns = new Set((db.prepare('PRAGMA table_info(translations)').all() as Array<{ name: string }>).map(column => column.name));
    if (!translationColumns.has('review_note')) db.exec('ALTER TABLE translations ADD COLUMN review_note TEXT');
    if (!translationColumns.has('revision')) db.exec('ALTER TABLE translations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    db.exec(`CREATE TABLE IF NOT EXISTS translation_versions (
      translation_id TEXT NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      content TEXT NOT NULL,
      review_status TEXT NOT NULL CHECK (review_status IN ('pending','accepted','returned','not_selected')),
      review_note TEXT,
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      PRIMARY KEY (translation_id,revision)
    );
    UPDATE assignments SET status='assigned' WHERE status='submitted'
      AND EXISTS (SELECT 1 FROM translations t WHERE t.sentence_id=assignments.sentence_id AND t.user_id=assignments.user_id AND t.status='rejected')
      AND NOT EXISTS (SELECT 1 FROM translations winner WHERE winner.sentence_id=assignments.sentence_id AND winner.status='accepted');
    INSERT OR IGNORE INTO translation_versions
      (translation_id,revision,content,review_status,review_note,submitted_at,reviewed_at)
      SELECT t.id,t.revision,t.content,${reviewStatusSql()},t.review_note,t.created_at,t.reviewed_at FROM translations t;`);
  }).immediate();
  // Encrypt legacy plaintext identity fields on the first start after the
  // production key is configured. Existing encrypted values are left intact.
  if (process.env.PII_ENCRYPTION_KEY?.trim()) {
    db.exec('DROP INDEX IF EXISTS idx_users_phone_unique');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_hash_unique ON users(phone_hash) WHERE phone_hash IS NOT NULL AND phone_hash <> \'\'');
    const legacyRows = db.prepare("SELECT id,phone,id_number as idNumber,bank_card_no as bankCardNo,verification_source as verificationSource FROM users WHERE (phone IS NOT NULL AND phone <> '' AND phone NOT LIKE 'enc:v1:%' AND (phone_hash IS NULL OR phone_hash='')) OR (id_number IS NOT NULL AND id_number <> '' AND id_number NOT LIKE 'enc:v1:%') OR (bank_card_no IS NOT NULL AND bank_card_no <> '' AND bank_card_no NOT LIKE 'enc:v1:%')").all() as Array<{ id: string; phone: string | null; idNumber: string | null; bankCardNo: string | null; verificationSource: string }>;
    const update = db.prepare('UPDATE users SET phone=?, phone_hash=?, id_number=?, bank_card_no=? WHERE id=?');
    db.transaction(() => {
      for (const row of legacyRows) {
        const phone = decryptPii(row.phone);
        update.run(encryptPii(phone), row.verificationSource === 'registration_bypass' ? null : hashPii(phone), encryptPii(row.idNumber), encryptPii(row.bankCardNo), row.id);
      }
    })();
  }
  return db as unknown as DB;
}

export function createDb(dbPath: string): DB {
  const engine = (process.env.DB_ENGINE || '').trim().toLowerCase();
  if (engine === 'mysql') return createMysqlDb();
  return createSqliteDb(dbPath);
}

export function id(): string {
  return crypto.randomUUID();
}

export function seedDemo(db: DB): void {
  if (process.env.SEED_DEMO !== 'true') return;
  const articleCount = (db.prepare('SELECT COUNT(*) as count FROM articles').get() as { count: number }).count;
  if (articleCount > 0) return;
  const demoUserId = id();
  const articleId = id();
  const sentences = [
    '这是一个众包翻译平台的演示文章。',
    '每位参与者会随机获得一到两句原文。',
    '管理员可以在后台审核并汇总最终译文。'
  ];
  const insertUser = db.prepare('INSERT INTO users (id,name,open_id) VALUES (?,?,?)');
  const insertArticle = db.prepare('INSERT INTO articles (id,title,source_language,target_language,source_file_name,translator_slots) VALUES (?,?,?,?,?,?)');
  const insertSentence = db.prepare('INSERT INTO sentences (id,article_id,position,source_text,translator_slots) VALUES (?,?,?,?,?)');
  const insertAssignment = db.prepare('INSERT INTO assignments (id,sentence_id,user_id) VALUES (?,?,?)');
  const seed = db.transaction(() => {
    insertUser.run(demoUserId, '演示用户', 'demo-open-id');
    insertArticle.run(articleId, '众包翻译平台演示', '中文', '英文', 'demo.txt', 2);
    sentences.forEach((text, index) => {
      const sentenceId = id();
      insertSentence.run(sentenceId, articleId, index + 1, text, 2);
      if (index < 2) insertAssignment.run(id(), sentenceId, demoUserId);
    });
  });
  seed();
}
