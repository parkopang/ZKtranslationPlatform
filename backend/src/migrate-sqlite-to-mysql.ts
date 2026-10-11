import Database from 'better-sqlite3';
import { createDb } from './db.js';

const sourcePath = process.env.MIGRATION_SQLITE_PATH || process.env.DB_PATH;
if (!sourcePath) throw new Error('MIGRATION_SQLITE_PATH is required');
const source = new Database(sourcePath, { readonly: true });
const target = createDb(':memory:');

function tableExists(name: string): boolean {
  return Boolean(source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columns(name: string): Set<string> {
  return new Set((source.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((row) => row.name));
}
function copyTable(name: string, fields: string[], defaults: Record<string, string | number | null> = {}): number {
  if (!tableExists(name)) return 0;
  const available = columns(name);
  const selected = fields.filter((field) => available.has(field));
  if (!selected.length) return 0;
  const rows = source.prepare(`SELECT ${selected.join(',')} FROM ${name}`).all() as Array<Record<string, unknown>>;
  const targetFields = fields;
  const placeholders = targetFields.map(() => '?').join(',');
  const insert = target.prepare(`INSERT IGNORE INTO ${name} (${targetFields.join(',')}) VALUES (${placeholders})`);
  const run = target.transaction(() => {
    for (const row of rows) insert.run(...targetFields.map((field) => selected.includes(field) ? row[field] : defaults[field] ?? null));
  });
  run();
  return rows.length;
}

const counts: Record<string, number> = {};
counts.users = copyTable('users', ['id','name','real_name','phone','phone_hash','id_number','bank_card_no','verification_status','verification_source','open_id','created_at'], { verification_status: 'pending', verification_source: 'unverified' });
counts.sessions = copyTable('sessions', ['id','token_hash','user_id','role','expires_at','created_at','revoked_at']);
counts.audit_logs = copyTable('audit_logs', ['id','actor_user_id','actor_role','action','resource_type','resource_id','metadata_json','ip','user_agent','created_at']);
counts.articles = copyTable('articles', ['id','title','source_language','target_language','source_file_name','source_object_key','source_sha256','source_size','translator_slots','created_at','updated_at'], { source_language: 'auto', target_language: '英文', translator_slots: 2 });
counts.sentences = copyTable('sentences', ['id','article_id','position','source_text','translator_slots','translation_suggestion','suggestion_status','suggestion_error','suggestion_retry_at','suggestion_attempts','suggestion_updated_at','suggestion_provider','suggestion_trace_id','created_at'], { translator_slots: 2, suggestion_status: 'idle', suggestion_attempts: 0, suggestion_updated_at: 0 });
counts.assignments = copyTable('assignments', ['id','sentence_id','user_id','status','assigned_at'], { status: 'assigned' });
counts.translations = copyTable('translations', ['id','sentence_id','user_id','content','status','created_at','reviewed_at','review_note','revision'], { status: 'pending', revision: 1 });
counts.translation_versions = copyTable('translation_versions', ['translation_id','revision','content','review_status','review_note','submitted_at','reviewed_at']);

console.log(JSON.stringify({ migrated: counts, source: sourcePath }, null, 2));
source.close();
target.close();
