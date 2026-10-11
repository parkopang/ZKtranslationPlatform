import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, id } from './db.js';
import { SuggestionService } from './suggestions.js';
import type { TranslationResult } from './translation.js';

process.env.PRETRANSLATE_RETRY_DELAY_MS = '60000';
process.env.PRETRANSLATE_JOB_ATTEMPTS = '3';
const dir = mkdtempSync(join(tmpdir(), 'translation-suggestion-test-'));
const path = join(dir, 'test.sqlite');
let db = createDb(path);
const article = id();
db.prepare('INSERT INTO articles(id,title,target_language) VALUES(?,?,?)').run(article, 'Original generated test text', '中文');
let position = 0;
function sentence() {
  const key = id();
  db.prepare('INSERT INTO sentences(id,article_id,position,source_text) VALUES(?,?,?,?)').run(key, article, ++position, 'A clear test sentence.');
  return key;
}
function state(key: string): any { return db.prepare('SELECT * FROM sentences WHERE id=?').get(key); }
let now = Date.now();
const local = { configured: () => false, ready: () => false, enqueue: async () => false };
let service: SuggestionService | undefined;
try {
  let calls = 0;
  const transient = sentence();
  service = new SuggestionService(db, async (): Promise<TranslationResult> => {
    calls++;
    return calls === 1 ? { text: '', provider: 'fallback', retryable: true, error: 'provider_rate_limited', retryAfterMs: 90_000 }
      : { text: '明确的测试句子。', provider: 'minimax' };
  }, () => now, local);
  await Promise.all(Array.from({length: 10}, () => service!.schedule(transient)));
  assert.equal(calls, 1, 'concurrent task reads must call provider only once');
  assert.equal(state(transient).translation_suggestion, null);
  assert.equal(state(transient).suggestion_status, 'retrying');
  assert.equal(state(transient).suggestion_retry_at, now + 90_000);
  await service.schedule(transient, true);
  await service.sweep();
  assert.equal(calls, 1, 'manual or automatic retry must respect Retry-After');
  await service.close();
  db.close();
  db = createDb(path);
  service = new SuggestionService(db, async () => { calls++; return {text: '明确的测试句子。', provider: 'minimax'}; }, () => now, local);
  now += 90_001;
  await service.sweep();
  assert.equal(calls, 2, 'pending retry must survive DB reopen / process restart');
  assert.equal(state(transient).suggestion_status, 'succeeded');
  assert.equal(state(transient).translation_suggestion, '明确的测试句子。');
  await service.close();

  const permanent = sentence(); calls = 0;
  service = new SuggestionService(db, async () => { calls++; return {text: '', provider: 'fallback', retryable: false, error: 'provider_plan_quota_exhausted'}; }, () => now, local);
  await service.schedule(permanent);
  now += 120_000;
  await service.sweep();
  await service.schedule(permanent);
  assert.equal(calls, 1, 'quota exhaustion must not be retried by page polling');
  assert.equal(state(permanent).suggestion_status, 'failed');
  assert.equal(state(permanent).translation_suggestion, null);
  await service.schedule(permanent, true);
  assert.equal(calls, 2, 'admin can explicitly retry after fixing cause and cooldown');
  await service.close();

  const exhausted = sentence(); calls = 0;
  service = new SuggestionService(db, async () => { calls++; throw new Error('do-not-leak-secret'); }, () => now, local);
  await service.schedule(exhausted);
  for (let i=0;i<5;i++) { now += 600_000; await service.sweep(); }
  assert.equal(calls, 3, 'job rounds must be bounded');
  assert.equal(state(exhausted).suggestion_status, 'failed');
  assert.equal(state(exhausted).suggestion_error, 'provider_unavailable');
  assert.equal(state(exhausted).translation_suggestion, null);
  await service.close();

  const unavailable = sentence(); calls = 0;
  service = new SuggestionService(db, async () => { calls++; return {text:'must not happen',provider:'minimax'}; }, () => now,
    { configured: () => true, ready: () => false, enqueue: async () => { throw new Error('redis-secret'); } });
  await service.schedule(unavailable);
  assert.equal(calls, 0, 'configured Redis failure must never bypass queue');
  assert.equal(state(unavailable).suggestion_status, 'retrying');
  assert.equal(state(unavailable).suggestion_error, 'queue_unavailable');
  await service.close();

  const oldPlaceholder = sentence(); const valid = sentence();
  db.prepare('UPDATE sentences SET translation_suggestion=? WHERE id=?').run('[中文预翻译] A clear test sentence.', oldPlaceholder);
  db.prepare('UPDATE sentences SET translation_suggestion=? WHERE id=?').run('保留真实旧译文', valid);
  db.close(); db = createDb(path);
  assert.equal(state(oldPlaceholder).translation_suggestion, null, 'migration removes exact legacy fallback only');
  assert.equal(state(oldPlaceholder).suggestion_status, 'idle');
  assert.equal(state(valid).translation_suggestion, '保留真实旧译文');
  assert.equal(state(valid).suggestion_status, 'succeeded');
  console.log('suggestion persistence tests passed: dedupe, delayed retry, restart recovery, quota failure, bounded retries, Redis fail-closed, legacy migration');
} finally {
  await service?.close();
  db.close();
  rmSync(dir, {recursive: true, force: true});
}
