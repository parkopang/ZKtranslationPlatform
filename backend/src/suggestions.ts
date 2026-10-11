import type { DB } from './db.js';
import { pretranslate, type TranslationResult } from './translation.js';
import { enqueuePretranslate, queueConfigured, workerReady } from './queue.js';

type SentenceJob = {
  id: string; sourceText: string; targetLanguage: string; translationSuggestion: string | null;
  status: string; attempts: number; retryAt: number | null; updatedAt: number;
};
const fields = `s.id,s.source_text AS sourceText,a.target_language AS targetLanguage,
  s.translation_suggestion AS translationSuggestion,s.suggestion_status AS status,
  s.suggestion_attempts AS attempts,s.suggestion_retry_at AS retryAt,s.suggestion_updated_at AS updatedAt`;
const positiveInt = (value: string | undefined, fallback: number, max: number) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(max, number) : fallback;
};

/** Single backend instance, matching the SQLite deployment contract. SQLite is
 * the durable retry ledger; Redis transports IDs only. Never bypass Redis when
 * it is configured but unavailable, or a provider failure can cause a storm. */
export class SuggestionService {
  private jobs = new Map<string, Promise<void>>();
  private enqueues = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private rounds = positiveInt(process.env.PRETRANSLATE_JOB_ATTEMPTS, 3, 5);
  private backoff = positiveInt(process.env.PRETRANSLATE_RETRY_DELAY_MS, 60_000, 3_600_000);
  private lease = Math.max(300_000, positiveInt(process.env.LLM_TOTAL_TIMEOUT_MS, 120_000, 600_000) + 60_000);

  constructor(private db: DB, private translate = pretranslate, private now = Date.now,
    private transport = { configured: queueConfigured, ready: workerReady, enqueue: enqueuePretranslate }) {}

  private get(sentenceId: string): SentenceJob | undefined {
    return this.db.prepare(`SELECT ${fields} FROM sentences s JOIN articles a ON a.id=s.article_id WHERE s.id=?`).get(sentenceId) as SentenceJob | undefined;
  }

  async schedule(sentenceId: string, force = false): Promise<void> {
    if (this.stopped) return;
    if (this.jobs.has(sentenceId)) return;
    const pending = this.enqueues.get(sentenceId);
    if (pending) return pending;
    const sentence = this.get(sentenceId);
    if (!sentence || sentence.translationSuggestion || sentence.status === 'succeeded') return;
    const now = this.now();
    // Even explicit retries must respect the provider's cooldown.
    if (sentence.retryAt && sentence.retryAt > now) return;
    if (['queued', 'running'].includes(sentence.status) && sentence.updatedAt > now - this.lease) return;
    if (sentence.status === 'failed' && !force) return;
    this.db.prepare(`UPDATE sentences SET suggestion_status='queued',suggestion_updated_at=?,suggestion_retry_at=NULL,
      suggestion_attempts=CASE WHEN ? THEN 0 ELSE suggestion_attempts END WHERE id=?`).run(now, force ? 1 : 0, sentenceId);
    const enqueue = (async () => {
      if (this.transport.configured()) {
        try {
          if (!this.transport.ready() || !await this.transport.enqueue(sentenceId)) throw new Error('queue_unavailable');
        } catch {
          this.db.prepare(`UPDATE sentences SET suggestion_status='retrying',suggestion_error='queue_unavailable',
            suggestion_retry_at=?,suggestion_updated_at=? WHERE id=? AND suggestion_status='queued'`)
            .run(this.now() + this.backoff, this.now(), sentenceId);
        }
      } else {
        // Local development also goes through the provider's bounded pool.
        await this.generate(sentenceId);
      }
    })().finally(() => this.enqueues.delete(sentenceId));
    this.enqueues.set(sentenceId, enqueue);
    return enqueue;
  }

  generate = (sentenceId: string): Promise<void> => {
    if (this.stopped) return Promise.resolve();
    const running = this.jobs.get(sentenceId);
    if (running) return running;
    const sentence = this.get(sentenceId);
    if (!sentence || sentence.translationSuggestion || sentence.status === 'failed' || sentence.status === 'succeeded') return Promise.resolve();
    if (sentence.retryAt && sentence.retryAt > this.now()) return Promise.resolve();
    if (sentence.attempts >= this.rounds) {
      this.db.prepare("UPDATE sentences SET suggestion_status='failed',suggestion_error='retry_exhausted',suggestion_retry_at=NULL WHERE id=?").run(sentenceId);
      return Promise.resolve();
    }
    const now = this.now();
    this.db.prepare(`UPDATE sentences SET suggestion_status='running',suggestion_attempts=suggestion_attempts+1,
      suggestion_updated_at=?,suggestion_error=NULL,suggestion_retry_at=NULL WHERE id=?`).run(now, sentenceId);
    const task = (async () => {
      let result: TranslationResult;
      try { result = await this.translate(sentence.sourceText, sentence.targetLanguage); }
      catch { result = { text: '', provider: 'fallback', error: 'provider_unavailable', retryable: true }; }
      // Only an actual, validated model result may enter translation_suggestion.
      if (result.provider !== 'fallback' && !result.error && result.text.trim()) {
        this.db.prepare(`UPDATE sentences SET translation_suggestion=?,suggestion_status='succeeded',suggestion_error=NULL,
          suggestion_retry_at=NULL,suggestion_updated_at=?,suggestion_provider=?,suggestion_trace_id=?
          WHERE id=? AND translation_suggestion IS NULL`).run(result.text, this.now(), result.provider, result.traceId || null, sentenceId);
      } else {
        const retry = Boolean(result.retryable) && sentence.attempts + 1 < this.rounds;
        const delay = Math.max(this.backoff * 2 ** sentence.attempts, result.retryAfterMs || 0);
        this.db.prepare(`UPDATE sentences SET suggestion_status=?,suggestion_error=?,suggestion_retry_at=?,suggestion_updated_at=?,
          suggestion_provider=?,suggestion_trace_id=? WHERE id=? AND translation_suggestion IS NULL`)
          .run(retry ? 'retrying' : 'failed', result.error || 'provider_empty_response', this.now() + delay, this.now(), result.provider, result.traceId || null, sentenceId);
      }
    })().finally(() => this.jobs.delete(sentenceId));
    this.jobs.set(sentenceId, task);
    return task;
  };

  async sweep(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const due = this.db.prepare(`SELECT id FROM sentences WHERE translation_suggestion IS NULL AND
      ((suggestion_status='retrying' AND suggestion_retry_at<=?) OR
       (suggestion_status IN ('queued','running') AND suggestion_updated_at<=?))
      ORDER BY COALESCE(suggestion_retry_at,suggestion_updated_at) LIMIT 32`).all(now, now - this.lease) as Array<{id: string}>;
    await Promise.allSettled(due.map(row => this.schedule(row.id)));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, 5000);
    this.timer.unref();
    void this.sweep();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.enqueues.values(), ...this.jobs.values()]);
  }
}
