// Runs inside the already-loaded backend image. No host mounts or extra tools.
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');

process.umask(0o077);
const dbPath = process.env.RESTORE_DB_PATH || '/app/data/translation.sqlite';
const work = process.env.RESTORE_WORK_DIR;
if (!work || path.dirname(work) !== path.dirname(dbPath) || !path.basename(work).startsWith('.restore-')) {
  throw new Error('Invalid restore work directory');
}
const lock = path.join(path.dirname(dbPath), '.restore-lock');
const staged = path.join(work, 'incoming.sqlite');
const previous = path.join(work, 'before.sqlite');
const metadataFile = path.join(work, 'metadata.json');
const ownsLock = () => fs.existsSync(path.join(lock, 'owner')) && fs.readFileSync(path.join(lock, 'owner'), 'utf8') === work;
const requireLock = () => { if (!ownsLock()) throw new Error('Restore lock is not owned by this operation'); };

function validateSqlite(file) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (header.toString('binary') !== 'SQLite format 3\0') throw new Error('Backup is not a complete SQLite database');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const checks = db.pragma('integrity_check');
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error('SQLite integrity_check failed');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of ['users', 'articles', 'sentences', 'assignments', 'translations']) {
      if (!tables.has(name)) throw new Error(`Backup is missing translation-platform table: ${name}`);
    }
  } finally { db.close(); }
}

function replaceDatabase(source, metadata) {
  fs.chownSync(source, metadata.uid, metadata.gid);
  fs.chmodSync(source, metadata.mode);
  const fd = fs.openSync(source, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // The application must be stopped before entering this function.
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(dbPath + suffix, { force: true });
  fs.renameSync(source, dbPath);
  const dirFd = fs.openSync(path.dirname(dbPath), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

async function main() {
  switch (process.argv[1]) {
    case 'validate': {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, 'owner'), work, { mode: 0o600 });
      fs.mkdirSync(work, { mode: 0o700 });
      await pipeline(process.stdin, fs.createWriteStream(staged, { flags: 'wx', mode: 0o600 }));
      validateSqlite(staged);
      break;
    }
    case 'install': {
      requireLock();
      validateSqlite(staged);
      const stat = fs.statSync(dbPath);
      const metadata = { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
      fs.writeFileSync(metadataFile, JSON.stringify(metadata), { mode: 0o600 });
      // SQLite's backup API includes committed WAL content in a standalone
      // snapshot, so the rollback never depends on a discarded WAL file.
      const current = new Database(dbPath, { readonly: true, fileMustExist: true });
      try { await current.backup(previous); } finally { current.close(); }
      fs.chmodSync(previous, 0o600);
      validateSqlite(previous);
      fs.writeFileSync(path.join(work, 'rollback-ready'), '', { mode: 0o600 });
      replaceDatabase(staged, metadata);
      break;
    }
    case 'rollback': {
      requireLock();
      if (!fs.existsSync(path.join(work, 'rollback-ready'))) break;
      validateSqlite(previous);
      const rollbackFile = path.join(work, 'rollback.sqlite');
      fs.copyFileSync(previous, rollbackFile);
      replaceDatabase(rollbackFile, JSON.parse(fs.readFileSync(metadataFile, 'utf8')));
      break;
    }
    case 'cleanup': {
      if (!ownsLock()) break;
      if (fs.existsSync(path.join(work, 'rollback-ready'))) {
        for (const name of ['incoming.sqlite', 'incoming.sqlite-wal', 'incoming.sqlite-shm', 'rollback.sqlite']) {
          fs.rmSync(path.join(work, name), { force: true });
        }
      } else {
        fs.rmSync(work, { recursive: true, force: true });
      }
      fs.rmSync(lock, { recursive: true });
      break;
    }
    default: throw new Error('Unknown restore phase');
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
