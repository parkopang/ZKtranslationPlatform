import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import mammoth from 'mammoth';
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { createDb, id, seedDemo, DEFAULT_ENTRY_ID, type DB } from './db.js';
import { articleSentenceViews, articleViews } from './articles.js';
import { reviewFieldsSql, reviewStatusSql, taskViews, translationHistory, translationView } from './reviews.js';
import { decryptPii, encryptPii, hashPii, hasPiiEncryptionKey } from './pii.js';
import { sourceFileUrl, storageConfigured, storeSourceFile } from './storage.js';
import { getModelConfiguration, assertModelConfiguration, getModelMetrics } from './translation.js';
import { SuggestionService } from './suggestions.js';
import { closeQueue, enqueuePretranslate, queueConfigured, queueReady, getQueueMetrics, startPretranslateWorker, workerReady } from './queue.js';

const port = Number(process.env.PORT || 8080);
if (process.env.NODE_ENV === 'production' && !hasPiiEncryptionKey()) {
  throw new Error('PII_ENCRYPTION_KEY is required in production');
}
assertModelConfiguration();
registrationMode();
if (getModelConfiguration().usageWarning) {
  console.warn(`model usage notice: ${getModelConfiguration().usageWarning}`);
}
const db = createDb(process.env.DB_PATH || './data/translation.sqlite');
seedDemo(db);
function registrationMode(): 'open' | 'standard' {
  const configured = process.env.REGISTRATION_MODE?.trim();
  if (configured === 'open' || configured === 'standard') return configured;
  if (configured) throw new Error('REGISTRATION_MODE must be open or standard');
  return process.env.SIMULATION_ENV === 'true' ? 'open' : 'standard';
}
const app = express();
app.disable('etag');
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// The production profile is behind the Nginx reverse proxy, so rate limits
// and audit logs should use the original client address from X-Forwarded-For.
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Browser cookies are used for translator/admin sessions. Reject cross-site
// state-changing requests even when a proxy or a permissive CORS setting is
// accidentally introduced later. Native clients without an Origin header
// remain supported.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
  const origin = req.header('origin');
  if (!origin) { next(); return; }
  const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const requestOrigin = `${forwardedProto || req.protocol}://${req.get('host')}`;
  if (origin === requestOrigin || corsOrigins.includes(origin)) { next(); return; }
  res.status(403).json({ error: '请求来源不受信任' });
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

type AuthSession = { id: string; userId: string | null; role: 'translator' | 'admin'; expiresAt: string };
type SessionRole = AuthSession['role'];
const roleCookieNames: Record<SessionRole, string> = {
  translator: 'translation_translator_session', admin: 'translation_admin_session',
};
const requestActors = new WeakMap<Request, { role: SessionRole; userId: string | null }>();

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(res: Response, role: SessionRole, token: string, maxAge = SESSION_TTL_SECONDS): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${roleCookieNames[role]}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function clearLegacySessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `translation_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function requestCookies(req: Request): Record<string, string> {
  const header = req.header('cookie') || '';
  const cookies: Record<string, string> = {};
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim();
    try { cookies[key] = decodeURIComponent(item.slice(separator + 1).trim()); } catch { /* ignore malformed cookies */ }
  }
  return cookies;
}

function createSession(userId: string | null, role: AuthSession['role']): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE julianday(expires_at) <= julianday(?) OR revoked_at IS NOT NULL').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (id,token_hash,user_id,role,expires_at) VALUES (?,?,?,?,?)').run(id(), hashSessionToken(token), userId, role, expiresAt);
  return token;
}

function bearerSessionToken(req: Request): string | undefined {
  return /^Bearer\s+/i.test(req.header('authorization') || '') ? req.header('authorization')!.replace(/^Bearer\s+/i, '') : undefined;
}

// Revoke every credential for the requested role carried by this browser. A
// legacy cookie may be a second session, so revoking only the preferred token
// would let it become active again after the new cookie was cleared.
function revokeRoleSessions(req: Request, role: SessionRole): boolean {
  const cookies = requestCookies(req);
  const legacy = cookies.translation_session
    ? db.prepare('SELECT role FROM sessions WHERE token_hash=?').get(hashSessionToken(cookies.translation_session)) as { role: SessionRole } | undefined
    : undefined;
  const revoke = db.prepare("UPDATE sessions SET revoked_at=datetime('now') WHERE token_hash=? AND role=?");
  for (const token of new Set([cookies[roleCookieNames[role]], cookies.translation_session, bearerSessionToken(req)].filter(Boolean) as string[])) {
    revoke.run(hashSessionToken(token), role);
  }
  return legacy?.role === role;
}

function sessionForToken(token: string | undefined, role: SessionRole): AuthSession | null {
  if (!token) return null;
  const row = db.prepare(`SELECT id,user_id as userId,role,expires_at as expiresAt
    FROM sessions WHERE token_hash=? AND role=? AND revoked_at IS NULL AND julianday(expires_at) > julianday('now')`).get(hashSessionToken(token), role) as AuthSession | undefined;
  return row || null;
}

function currentSession(req: Request, role: SessionRole): AuthSession | null {
  const cookies = requestCookies(req);
  // An explicit role cookie is authoritative, even when expired or invalid.
  // Falling back here could silently switch to an older volunteer's account.
  if (Object.hasOwn(cookies, roleCookieNames[role])) return sessionForToken(cookies[roleCookieNames[role]], role);
  return sessionForToken(cookies.translation_session, role) || sessionForToken(bearerSessionToken(req), role);
}

function startRoleSession(req: Request, res: Response, role: SessionRole, userId: string | null): void {
  const clearLegacy = revokeRoleSessions(req, role);
  const token = createSession(userId, role);
  setSessionCookie(res, role, token);
  if (clearLegacy) clearLegacySessionCookie(res);
  requestActors.set(req, { role, userId });
}

function endRoleSession(req: Request, res: Response, role: SessionRole): void {
  const session = currentSession(req, role);
  if (session) requestActors.set(req, session);
  const clearLegacy = revokeRoleSessions(req, role);
  setSessionCookie(res, role, '', 0);
  if (clearLegacy) clearLegacySessionCookie(res);
  if (session) audit(req, `${role}.logout`, 'session', session.id);
}

function audit(req: Request, action: string, resourceType: string, resourceId?: string | null, metadata?: Record<string, unknown>): void {
  const actor = requestActors.get(req);
  try {
    db.prepare(`INSERT INTO audit_logs
      (id,actor_user_id,actor_role,action,resource_type,resource_id,metadata_json,ip,user_agent)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      id(), actor?.userId || null, actor?.role || 'anonymous',
      action, resourceType, resourceId || null, metadata ? JSON.stringify(metadata) : null,
      req.ip || req.socket.remoteAddress || null, req.header('user-agent') || null,
    );
  } catch (error) {
    // Auditing must not turn a successful business operation into a 500, but
    // failures remain visible in the service log for alerting.
    console.error('audit write failed', error instanceof Error ? error.message : 'unknown error');
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const asyncRoute = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res, next).catch(next); };

function adminOnly(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.ADMIN_KEY?.trim();
  if (!configured) { res.status(503).json({ error: 'ADMIN_KEY is not configured' }); return; }
  if (process.env.NODE_ENV === 'production' && configured.length < 32) { res.status(503).json({ error: '生产环境 ADMIN_KEY 至少需要 32 个字符' }); return; }
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const key = req.header('x-admin-key') || bearer;
  const session = currentSession(req, 'admin');
  if (session) { requestActors.set(req, session); next(); return; }
  if (!key || !constantTimeEqual(key, configured)) { res.status(401).json({ error: '管理员鉴权失败' }); return; }
  requestActors.set(req, { role: 'admin', userId: null });
  next();
}

function translatorOnly(req: Request, res: Response, next: NextFunction): void {
  const session = currentSession(req, 'translator');
  if (!session || session.role !== 'translator' || !session.userId) { res.status(401).json({ error: '请先登录译者账号' }); return; }
  const expectedUserId = String(req.params.userId || req.body?.userId || req.query?.userId || '');
  if (expectedUserId && expectedUserId !== session.userId) { res.status(403).json({ error: '只能访问自己的任务' }); return; }
  requestActors.set(req, session);
  next();
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const uuidSchema = z.string().uuid();
const translatorSlotsSchema = z.number().int().min(1).max(20);
const taskUnitSchema = z.enum(['sentence', 'paragraph', 'chapter']);
const articleLanguageSchema = z.string().trim().min(1).max(30);
const entryCodeSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/i, '入口编码只能包含字母、数字、下划线和短横线');
const entryNameSchema = z.string().trim().min(1).max(200);
const entryChannelSchema = z.enum(['public_account', 'mini_program', 'web']);
const entryStatusSchema = z.enum(['active', 'disabled']);
const entryUrlSchema = z.string().trim().url().max(1024).optional().nullable();
function normalizeEntryChannel(value: unknown): string | null {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'public_account' || raw === 'public-account' || raw === 'wechat-public-account') return 'public_account';
  if (raw === 'mini_program' || raw === 'mini-program' || raw === 'wechat-mini-program') return 'mini_program';
  if (raw === 'web') return 'web';
  return null;
}
const articleFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(2_000_000),
  sourceLanguage: articleLanguageSchema.optional(),
  targetLanguage: articleLanguageSchema.optional(),
  taskUnit: taskUnitSchema.optional(),
  translatorSlots: translatorSlotsSchema.optional(),
});
// Multipart fields are strings; accept an integer spelling rather than coercing
// booleans, whitespace, fractions or an invalid value to the default capacity.
const importSlotsSchema = z.union([
  translatorSlotsSchema,
  z.string().regex(/^\d{1,2}$/).transform(Number).pipe(translatorSlotsSchema),
]).optional();

function maskIdentity(value: string | null | undefined, visibleStart = 3, visibleEnd = 2): string | null {
  if (!value) return null;
  if (value.length <= visibleStart + visibleEnd) return '*'.repeat(value.length);
  return `${value.slice(0, visibleStart)}${'*'.repeat(value.length - visibleStart - visibleEnd)}${value.slice(-visibleEnd)}`;
}

function publicUser(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!row) return undefined;
  return {
    ...row,
    phone: maskIdentity(decryptPii(row.phone as string | null), 3, 2),
    idNumber: maskIdentity(decryptPii(row.idNumber as string | null)),
    bankCardNo: maskIdentity(decryptPii(row.bankCardNo as string | null), 4, 4),
  };
}

function entryView(entryId: string | null | undefined): Record<string, unknown> | undefined {
  if (!entryId) return undefined;
  return db.prepare(`SELECT id,code,name,channel,status,url,created_at as createdAt,updated_at as updatedAt
    FROM entry_points WHERE id=?`).get(entryId) as Record<string, unknown> | undefined;
}

function publicEntry(row: unknown): Record<string, unknown> | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = row as Record<string, unknown>;
  return { id: value.id, code: value.code, name: value.name, channel: value.channel, status: value.status, enabled: value.status === 'active', url: value.url, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function userSelect(extra = ''): string {
  return `SELECT u.id,u.name,u.real_name as realName,u.phone,u.id_number as idNumber,u.bank_card_no as bankCardNo,
    u.verification_status as verificationStatus,u.verification_source as verificationSource,u.open_id as openId,
    u.entry_id as entryId,e.code as entryCode,e.name as entryName,e.channel as entryChannel,e.status as entryStatus,e.url as entryUrl,
    u.created_at as createdAt FROM users u LEFT JOIN entry_points e ON e.id=u.entry_id ${extra}`;
}

type TaskUnit = z.infer<typeof taskUnitSchema>;

function normalizeArticleText(text: string): string {
  const normalized = text.replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
  return normalized.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
}

function splitSentences(text: string): string[] {
  const normalized = normalizeArticleText(text);
  if (!normalized) return [];
  const pieces = normalized.split(/(?<=[。！？!?；;.])\s*|\n+/u).map((s) => s.trim()).filter(Boolean);
  return pieces.length ? pieces : [normalized];
}

function splitParagraphs(text: string): string[] {
  const normalized = normalizeArticleText(text);
  if (!normalized) return [];
  // Mammoth emits one line per Word paragraph; plain text commonly uses blank
  // lines. Treat every non-empty line as a paragraph so both formats behave
  // consistently while preserving the paragraph's internal punctuation.
  return normalized.split(/\n+/u).map((s) => s.trim()).filter(Boolean);
}

function isChapterHeading(line: string): boolean {
  const value = line.trim();
  if (!value || value.length > 160) return false;
  return /^(?:#{1,6}\s+\S+|(?:chapter|part|section|book|volume)\s+(?:[0-9]+|[ivxlcdm]+|[a-z]+)\b.*|第\s*[0-9一二三四五六七八九十百千万]+\s*[章节部篇卷].*|[0-9]+(?:\.[0-9]+)*[、.\s]+\S.*)$/iu.test(value);
}

function splitChapters(text: string): string[] {
  const normalized = normalizeArticleText(text);
  if (!normalized) return [];
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const headingIndexes = lines.map((line, index) => isChapterHeading(line) ? index : -1).filter((index) => index >= 0);
  if (headingIndexes.length < 2) return splitParagraphs(normalized);
  const chapters: string[] = [];
  if (headingIndexes[0] > 0) chapters.push(lines.slice(0, headingIndexes[0]).join('\n'));
  headingIndexes.forEach((start, index) => {
    const end = headingIndexes[index + 1] ?? lines.length;
    const chapter = lines.slice(start, end).join('\n').trim();
    if (chapter) chapters.push(chapter);
  });
  return chapters;
}

function splitTaskUnits(text: string, taskUnit: TaskUnit): string[] {
  if (taskUnit === 'paragraph') return splitParagraphs(text);
  if (taskUnit === 'chapter') return splitChapters(text);
  return splitSentences(text);
}

async function extractText(file: Express.Multer.File): Promise<string> {
  const lower = path.basename(file.originalname || '').toLowerCase();
  if (lower.endsWith('.docx')) {
    try {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return result.value;
    } catch {
      throw Object.assign(new Error('DOCX 文件无法解析，请确认文件未损坏'), { statusCode: 400 });
    }
  }
  if (!lower.endsWith('.txt')) throw Object.assign(new Error('仅支持 .docx 或 .txt 文件'), { statusCode: 400 });
  return file.buffer.toString('utf8');
}

const suggestions = new SuggestionService(db);
const scheduleSuggestion = (sentenceId: string) => suggestions.schedule(sentenceId);

function createArticle(dbConn: DB, input: { articleId?: string; title: string; text: string; sourceLanguage?: string; targetLanguage?: string; taskUnit?: TaskUnit; sourceFileName?: string; sourceObjectKey?: string | null; sourceSha256?: string | null; sourceSize?: number | null; translatorSlots?: number }) {
  const articleId = input.articleId || id();
  const taskUnit = taskUnitSchema.parse(input.taskUnit ?? 'sentence');
  const segments = splitTaskUnits(input.text, taskUnit);
  if (!segments.length) throw Object.assign(new Error('文章内容为空，无法导入'), { statusCode: 400 });
  const slots = translatorSlotsSchema.parse(input.translatorSlots ?? 2);
  const insertArticle = dbConn.prepare("INSERT INTO articles (id,title,source_language,target_language,task_unit,source_file_name,source_object_key,source_sha256,source_size,translator_slots,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))");
  const insertSentence = dbConn.prepare('INSERT INTO sentences (id,article_id,position,source_text,translator_slots) VALUES (?,?,?,?,?)');
  const tx = dbConn.transaction(() => {
    insertArticle.run(articleId, input.title, input.sourceLanguage || 'auto', input.targetLanguage || '英文', taskUnit, input.sourceFileName || null, input.sourceObjectKey || null, input.sourceSha256 || null, input.sourceSize || null, slots);
    segments.forEach((text, index) => insertSentence.run(id(), articleId, index + 1, text, slots));
  });
  tx();
  return { articleId, segmentCount: segments.length, sentenceCount: segments.length, taskUnit };
}

function sentenceView(sentenceId: string) {
  return db.prepare(`SELECT s.id,s.article_id as articleId,s.position,s.source_text as sourceText,
    s.translator_slots as translatorSlots,s.translation_suggestion as translationSuggestion,
    s.suggestion_status as suggestionStatus,s.suggestion_error as suggestionError,s.suggestion_retry_at as suggestionRetryAt,
    a.title,a.task_unit as taskUnit,a.source_language as sourceLanguage,a.target_language as targetLanguage
    FROM sentences s JOIN articles a ON a.id=s.article_id WHERE s.id=?`).get(sentenceId);
}

app.get(['/health', '/api/health'], (_req, res) => {
  const result = db.prepare('SELECT 1 as ok').get() as { ok: number };
  const modelConfiguration = getModelConfiguration();
  res.json({
    ok: result.ok === 1,
    service: 'translation-platform-backend',
    modelConfigured: modelConfiguration.configured,
    modelKeyType: modelConfiguration.keyType,
    modelProvider: modelConfiguration.provider,
    modelUsageWarning: modelConfiguration.usageWarning,
    modelFallback: modelConfiguration.fallback,
    piiEncryptionConfigured: hasPiiEncryptionKey(),
    objectStorageConfigured: storageConfigured(),
    queueConfigured: queueConfigured(),
    queueReady: queueReady(),
    pretranslateWorkerReady: workerReady(),
  });
});

app.get(['/readyz', '/api/readyz'], (_req, res) => {
  const databaseReady = (db.prepare('SELECT 1 as ok').get() as { ok: number }).ok === 1;
  const modelConfiguration = getModelConfiguration();
  const modelReady = modelConfiguration.configured;
  const queueReadyForProduction = !queueConfigured() || workerReady();
  const storageReadyForProduction = process.env.NODE_ENV !== 'production' || storageConfigured();
  const ready = databaseReady && modelReady && queueReadyForProduction && storageReadyForProduction;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'translation-platform-backend',
    checks: { database: databaseReady, model: modelReady, queue: queueReadyForProduction, objectStorage: storageReadyForProduction },
    modelCheck: 'configuration_only',
    modelUsageWarning: modelConfiguration.usageWarning,
    modelFallback: modelConfiguration.fallback,
  });
});

app.get('/api/admin/metrics', adminOnly, asyncRoute(async (req, res) => {
  audit(req, 'metrics.read', 'system');
  const activeSessions = db.prepare("SELECT COUNT(*) as count FROM sessions WHERE revoked_at IS NULL AND julianday(expires_at) > julianday('now')").get() as { count: number };
  const counts = db.prepare(`SELECT
    (SELECT COUNT(*) FROM users) as users,
    (SELECT COUNT(*) FROM articles) as articles,
    (SELECT COUNT(*) FROM sentences) as sentences,
    (SELECT COUNT(*) FROM translations WHERE status='pending') as pendingTranslations,
    (SELECT COUNT(*) FROM audit_logs) as auditEvents`).get() as Record<string, number>;
  res.json({ uptimeSeconds: Math.round(process.uptime()), memory: process.memoryUsage(), activeSessions: activeSessions.count, queueConfigured: queueConfigured(), queueReady: queueReady(), queue: await getQueueMetrics(), model: getModelMetrics(), modelConfiguration: getModelConfiguration(),
    suggestions: db.prepare('SELECT suggestion_status AS status,COUNT(*) AS count FROM sentences GROUP BY suggestion_status').all(), ...counts });
}));

app.get('/api/admin/audit-logs', adminOnly, (req, res) => {
  const limit = Math.min(200, parsePositiveInt(req.query.limit, 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  audit(req, 'audit.read', 'audit_log', null, { limit, offset });
  const logs = db.prepare(`SELECT l.id,l.actor_user_id as actorUserId,l.actor_role as actorRole,l.action,
      l.resource_type as resourceType,l.resource_id as resourceId,l.metadata_json as metadataJson,
      l.ip,l.user_agent as userAgent,l.created_at as createdAt,u.name as actorName
    FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_user_id
    ORDER BY l.created_at DESC,l.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  res.json({ logs, limit, offset });
});

// Entry points distinguish volunteers arriving from different public accounts
// and mini-programs. Active entry metadata is public so a registration page can
// render the correct channel and carry its code into registration.
app.get('/api/entries', (req, res) => {
  const channel = normalizeEntryChannel(req.query.channel);
  const entries = db.prepare(`SELECT id,code,name,channel,status,url,created_at as createdAt,updated_at as updatedAt
    FROM entry_points WHERE status='active' AND (? IS NULL OR channel=?) ORDER BY name,code`).all(channel, channel).map(publicEntry);
  res.json({ entries });
});

app.get('/api/admin/entries', adminOnly, (req, res) => {
  const statusValue = typeof req.query.status === 'string' ? req.query.status : '';
  const status = statusValue && entryStatusSchema.safeParse(statusValue).success ? statusValue : null;
  const entries = db.prepare(`SELECT id,code,name,channel,status,url,created_at as createdAt,updated_at as updatedAt
    FROM entry_points WHERE (? IS NULL OR status=?) ORDER BY name,code`).all(status, status).map(publicEntry);
  audit(req, 'admin.entries.list', 'entry');
  res.json({ entries });
});

app.post('/api/admin/entries', adminOnly, writeLimiter, (req, res) => {
  const parsed = z.object({ code: entryCodeSchema, name: entryNameSchema, channel: entryChannelSchema,
    status: entryStatusSchema.optional(), enabled: z.boolean().optional(), url: entryUrlSchema }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: '入口编码、名称、类型或链接格式不正确', details: parsed.error.flatten() }); return; }
  const entryId = id();
  try {
    const status = parsed.data.status || (parsed.data.enabled === false ? 'disabled' : 'active');
    db.prepare(`INSERT INTO entry_points (id,code,name,channel,status,url,updated_at) VALUES (?,?,?,?,?,?,datetime('now'))`)
      .run(entryId, parsed.data.code, parsed.data.name, parsed.data.channel, status, parsed.data.url || null);
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' || (error as { code?: string }).code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '入口编码已存在' }); return;
    }
    throw error;
  }
  const entry = publicEntry(entryView(entryId));
  audit(req, 'admin.entry.create', 'entry', entryId, { code: parsed.data.code, channel: parsed.data.channel });
  res.status(201).json({ entry });
});

app.patch('/api/admin/entries/:entryId', adminOnly, writeLimiter, (req, res) => {
  const parsed = z.object({ code: entryCodeSchema.optional(), name: entryNameSchema.optional(), channel: entryChannelSchema.optional(),
    status: entryStatusSchema.optional(), enabled: z.boolean().optional(), url: entryUrlSchema }).strict().safeParse(req.body);
  if (!parsed.success || !Object.keys(parsed.data).length) { res.status(400).json({ error: '请提供需要更新的入口配置', details: parsed.success ? undefined : parsed.error.flatten() }); return; }
  const current = entryView(String(req.params.entryId));
  if (!current) { res.status(404).json({ error: '入口不存在' }); return; }
  if (parsed.data.code !== undefined && parsed.data.code !== String(current.code)) {
    res.status(400).json({ error: '入口唯一标识创建后不能修改，请停用旧入口并新建入口' }); return;
  }
  if (String(req.params.entryId) === DEFAULT_ENTRY_ID && parsed.data.status === 'disabled') {
    res.status(400).json({ error: '默认入口不能停用，请先配置新的入口' }); return;
  }
  const next = { code: parsed.data.code ?? String(current.code), name: parsed.data.name ?? String(current.name),
    channel: parsed.data.channel ?? String(current.channel), status: parsed.data.status ?? (parsed.data.enabled === undefined ? String(current.status) : parsed.data.enabled ? 'active' : 'disabled'),
    url: parsed.data.url === undefined ? (current.url as string | null) : parsed.data.url };
  try {
    db.prepare(`UPDATE entry_points SET code=?,name=?,channel=?,status=?,url=?,updated_at=datetime('now') WHERE id=?`)
      .run(next.code, next.name, next.channel, next.status, next.url || null, req.params.entryId);
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' || (error as { code?: string }).code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: '入口编码已存在' }); return;
    }
    throw error;
  }
  audit(req, 'admin.entry.update', 'entry', String(req.params.entryId), { code: next.code, status: next.status });
  res.json({ entry: publicEntry(entryView(String(req.params.entryId))) });
});

app.delete('/api/admin/entries/:entryId', adminOnly, writeLimiter, (req, res) => {
  if (String(req.params.entryId) === DEFAULT_ENTRY_ID) { res.status(400).json({ error: '默认入口不能删除' }); return; }
  const result = db.prepare("UPDATE entry_points SET status='disabled',updated_at=datetime('now') WHERE id=?").run(req.params.entryId);
  if (!result.changes) { res.status(404).json({ error: '入口不存在' }); return; }
  audit(req, 'admin.entry.disable', 'entry', String(req.params.entryId));
  res.json({ ok: true, entry: publicEntry(entryView(String(req.params.entryId))) });
});

app.get('/api/articles', adminOnly, (req, res) => {
  audit(req, 'admin.articles.list', 'article');
  res.json({ articles: articleViews(db) });
});

app.get('/api/articles/:articleId', adminOnly, (req, res) => {
  const article = articleViews(db, String(req.params.articleId))[0];
  if (!article) { res.status(404).json({ error: '文章不存在' }); return; }
  const sentences = articleSentenceViews(db, String(req.params.articleId));
  res.json({ article, sentences });
});

app.post('/api/admin/auth/login', authLimiter, (req, res) => {
  const configured = process.env.ADMIN_KEY?.trim();
  const supplied = z.string().trim().min(1).safeParse(req.body?.key).success ? String(req.body.key).trim() : '';
  if (!configured || (process.env.NODE_ENV === 'production' && configured.length < 32) || !supplied || !constantTimeEqual(supplied, configured)) {
    res.status(401).json({ error: '管理员鉴权失败' });
    return;
  }
  startRoleSession(req, res, 'admin', null);
  audit(req, 'admin.login', 'session');
  res.json({ ok: true, expiresIn: SESSION_TTL_SECONDS });
});

app.get('/api/admin/auth/session', (req, res) => {
  const session = currentSession(req, 'admin');
  if (!session || session.role !== 'admin') { res.status(401).json({ authenticated: false }); return; }
  res.json({ authenticated: true, expiresAt: session.expiresAt });
});

app.post('/api/admin/auth/logout', (req, res) => {
  endRoleSession(req, res, 'admin');
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  endRoleSession(req, res, 'translator');
  res.json({ ok: true });
});

app.get('/api/auth/registration-config', (req, res) => {
  const open = registrationMode() === 'open';
  const entries = db.prepare(`SELECT id,code,name,channel,status,url FROM entry_points
    WHERE status='active' ORDER BY name,code`).all().map(publicEntry);
  const requestedCode = typeof req.query.entry === 'string' ? req.query.entry.trim() : typeof req.query.entryCode === 'string' ? req.query.entryCode.trim() : '';
  const channel = normalizeEntryChannel(req.query.channel) || '';
  const selected = requestedCode ? entries.find((entry) => entry?.code === requestedCode) : entries.find((entry) => entry?.code === 'default');
  if (requestedCode && (!selected || (channel && selected.channel !== channel))) {
    res.status(400).json({ error: '注册入口不存在、已停用或渠道不匹配' }); return;
  }
  res.json({ mode: open ? 'open' : 'standard', fieldsRequired: !open, externalVerificationEnabled: false, defaultEntryCode: 'default', entry: selected, entries });
});

app.post(['/api/users/register', '/api/auth/register'], authLimiter, (req, res) => {
  const openRegistration = registrationMode() === 'open';
  const standardSchema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    realName: z.string().trim().min(1).max(100),
    phone: z.string().trim().regex(/^\+?[0-9][0-9\-\s]{5,29}$/, '手机号格式不正确'),
    idNumber: z.string().trim().min(6).max(30),
    bankCardNo: z.string().trim().min(8).max(32),
    openId: z.string().trim().max(100).optional(),
    entryCode: entryCodeSchema.optional(), entryChannel: z.enum(['public_account', 'mini_program', 'web', 'public-account', 'mini-program']).optional(),
    entryId: uuidSchema.optional(),
  });
  // Explicit open-registration deployments admit volunteers without an external
  // identity check. Keep bounded strings but no format/required rules.
  const openSchema = z.object({
    name: z.string().trim().max(500).optional(), realName: z.string().trim().max(500).optional(),
    phone: z.string().trim().max(500).optional(), idNumber: z.string().trim().max(500).optional(),
    bankCardNo: z.string().trim().max(500).optional(), entryCode: z.string().trim().max(64).optional(), entryId: z.string().trim().max(100).optional(), entryChannel: z.string().trim().max(32).optional(),
  });
  const parsed = (openRegistration ? openSchema : standardSchema).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: openRegistration ? '注册资料请使用不超过 500 字的文本' : '姓名与手机号必填，身份证号、银行卡号用于后续实名核验', details: parsed.error.flatten() }); return; }
  const { name, realName, phone = '', idNumber = '', bankCardNo = '' } = parsed.data;
  const openId = 'openId' in parsed.data ? parsed.data.openId as string | undefined : undefined;
  const requestedEntryCode = 'entryCode' in parsed.data ? parsed.data.entryCode as string | undefined : undefined;
  const requestedEntryId = 'entryId' in parsed.data ? parsed.data.entryId as string | undefined : undefined;
  const requestedEntryChannel = 'entryChannel' in parsed.data ? String(parsed.data.entryChannel || '') : '';
  const selectedEntry = requestedEntryId
    ? db.prepare(`SELECT id,code,name,channel,status,url FROM entry_points WHERE id=?`).get(requestedEntryId) as Record<string, unknown> | undefined
    : requestedEntryCode
      ? db.prepare(`SELECT id,code,name,channel,status,url FROM entry_points WHERE code=?`).get(requestedEntryCode) as Record<string, unknown> | undefined
      : entryView(DEFAULT_ENTRY_ID);
  if (!selectedEntry || selectedEntry.status !== 'active') { res.status(400).json({ error: '请选择有效的注册入口' }); return; }
  const normalizedRequestedChannel = normalizeEntryChannel(requestedEntryChannel) || requestedEntryChannel;
  if (normalizedRequestedChannel && normalizedRequestedChannel !== selectedEntry.channel) { res.status(400).json({ error: '注册入口渠道不匹配' }); return; }
  if (openId) {
    if (db.prepare('SELECT id FROM users WHERE open_id=?').get(openId)) { res.status(409).json({ error: '该用户已注册，请使用已有登录会话' }); return; }
  }
  const phoneHash = openRegistration ? null : hashPii(phone);
  const existingPhone = phoneHash ? db.prepare('SELECT id FROM users WHERE phone_hash=?').get(phoneHash) : null;
  if (existingPhone) { res.status(409).json({ error: '该手机号已注册' }); return; }
  const userId = id();
  const displayName = realName || name || `志愿者${userId.slice(-6)}`;
  db.prepare('INSERT INTO users (id,name,real_name,phone,phone_hash,id_number,bank_card_no,open_id,entry_id,verification_status,verification_source) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(userId, displayName, realName || name || displayName, encryptPii(phone), phoneHash, encryptPii(idNumber), encryptPii(bankCardNo), openId || null, selectedEntry.id, openRegistration ? 'verified' : 'pending', openRegistration ? 'registration_bypass' : 'unverified');
  const user = db.prepare(`${userSelect('WHERE u.id=?')}`).get(userId) as Record<string, unknown>;
  startRoleSession(req, res, 'translator', userId);
  audit(req, 'translator.register', 'user', userId, { registrationMode: openRegistration ? 'open' : 'standard', externalVerificationPerformed: false, entryCode: selectedEntry.code, entryChannel: selectedEntry.channel });
  res.status(201).json({ user: publicUser(user), expiresIn: SESSION_TTL_SECONDS });
});

app.get('/api/auth/session', (req, res) => {
  const session = currentSession(req, 'translator');
  if (!session?.userId) { res.status(401).json({ authenticated: false }); return; }
  const user = db.prepare(`${userSelect('WHERE u.id=?')}`).get(session.userId) as Record<string, unknown> | undefined;
  if (!user) { res.status(401).json({ authenticated: false }); return; }
  res.json({ authenticated: true, user: publicUser(user), expiresAt: session.expiresAt });
});

app.get('/api/users/:userId', translatorOnly, (req, res) => {
  const user = db.prepare(`${userSelect('WHERE u.id=?')}`).get(req.params.userId) as Record<string, unknown> | undefined;
  if (!user) { res.status(404).json({ error: '用户不存在' }); return; }
  res.json({ user: publicUser(user) });
});

app.get('/api/admin/users', adminOnly, (req, res) => {
  audit(req, 'admin.users.list', 'user', null, { status: req.query.status || 'all' });
  const status = ['pending', 'verified', 'rejected'].includes(String(req.query.status)) ? String(req.query.status) : null;
  const entryCode = typeof req.query.entryCode === 'string' && req.query.entryCode.trim() ? req.query.entryCode.trim() : null;
  const users = db.prepare(`${userSelect(`WHERE (? IS NULL OR u.verification_status=?) AND (? IS NULL OR e.code=?) ORDER BY u.created_at DESC`)}`).all(status, status, entryCode, entryCode) as Array<Record<string, unknown>>;
  res.json({ users: users.map(publicUser) });
});

app.get('/api/admin/volunteers', adminOnly, (req, res) => {
  const entryCode = typeof req.query.entryCode === 'string' && req.query.entryCode.trim() ? req.query.entryCode.trim() : null;
  const volunteers = db.prepare(`SELECT u.id,u.name,u.entry_id AS entryId,e.code AS entryCode,e.name AS entryName,e.channel AS entryChannel,
    u.verification_status AS verificationStatus,u.verification_source AS verificationSource,
    (SELECT COUNT(*) FROM assignments x WHERE x.user_id=u.id) AS assignedCount,
    (SELECT COUNT(*) FROM assignments x WHERE x.user_id=u.id AND x.status='assigned') AS activeCount,
    (SELECT COUNT(*) FROM translations t WHERE t.user_id=u.id) AS submittedCount,
    (SELECT COUNT(*) FROM translations t WHERE t.user_id=u.id AND t.status='accepted') AS acceptedCount
    FROM users u LEFT JOIN entry_points e ON e.id=u.entry_id WHERE (? IS NULL OR e.code=?) ORDER BY u.created_at DESC,u.id`).all(entryCode, entryCode);
  res.json({ volunteers });
});

app.patch('/api/admin/users/:userId/verification', adminOnly, (req, res) => {
  const parsed = z.object({ status: z.enum(['pending', 'verified', 'rejected']) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'status 必须为 pending、verified 或 rejected' }); return; }
  const result = db.prepare("UPDATE users SET verification_status=?,verification_source='manual' WHERE id=?").run(parsed.data.status, req.params.userId);
  if (!result.changes) { res.status(404).json({ error: '用户不存在' }); return; }
  const user = db.prepare(`${userSelect('WHERE u.id=?')}`).get(req.params.userId) as Record<string, unknown>;
  audit(req, 'admin.user.verification', 'user', String(req.params.userId), { status: parsed.data.status });
  res.json({ user: publicUser(user) });
});

app.post('/api/admin/articles', adminOnly, writeLimiter, (req, res) => {
  const parsed = articleFieldsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'title/text 必填，且字段格式不正确', details: parsed.error.flatten() }); return; }
  const result = createArticle(db, parsed.data);
  audit(req, 'admin.article.create', 'article', result.articleId, { sentenceCount: result.sentenceCount });
  res.status(201).json({ ...result, article: articleViews(db, result.articleId)[0] });
});

app.post('/api/admin/articles/import', adminOnly, writeLimiter, upload.single('file'), asyncRoute(async (req, res) => {
  const file = req.file;
  const text = file ? await extractText(file) : String(req.body.text || '');
  const title = String(req.body.title || (file ? path.basename(file.originalname) : '') || '未命名文章').trim();
  if (title.length > 200) { res.status(400).json({ error: 'title 最多 200 个字符' }); return; }
  if (!text.trim()) { res.status(400).json({ error: '请上传 .docx/.txt 文件或提供 text' }); return; }
  if (text.length > 2_000_000) { res.status(400).json({ error: '文章内容不能超过 2MB' }); return; }
  const slots = importSlotsSchema.safeParse(req.body.translatorSlots);
  const parsed = articleFieldsSchema.safeParse({ title, text, sourceLanguage: req.body.sourceLanguage, targetLanguage: req.body.targetLanguage, taskUnit: req.body.taskUnit, translatorSlots: slots.success ? slots.data : undefined });
  if (!slots.success || !parsed.success) { res.status(400).json({ error: '标题、语种和任务单元不能为空，每句人数必须是 1-20 的整数' }); return; }
  const articleId = id();
  if (process.env.NODE_ENV === 'production' && file && !storageConfigured()) { res.status(503).json({ error: '生产环境未配置对象存储，无法保存原始文档' }); return; }
  const stored = file ? await storeSourceFile(articleId, file) : null;
  const result = createArticle(db, { ...parsed.data, articleId, sourceFileName: file?.originalname, sourceObjectKey: stored?.key, sourceSha256: stored?.sha256, sourceSize: stored?.size });
  audit(req, 'admin.article.import', 'article', result.articleId, { segmentCount: result.segmentCount, taskUnit: result.taskUnit, sourceFileName: file?.originalname || null, sourceStored: Boolean(stored) });
  res.status(201).json({ ...result, article: articleViews(db, result.articleId)[0] });
}));

app.patch('/api/admin/articles/:articleId/config', adminOnly, writeLimiter, (req, res) => {
  const parsed = z.object({ translatorSlots: translatorSlotsSchema, targetLanguage: articleLanguageSchema.optional() }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'translatorSlots 必须是 1-20 的整数', details: parsed.error.flatten() }); return; }
  const found = db.prepare('SELECT id,translator_slots as translatorSlots,target_language as targetLanguage FROM articles WHERE id=?').get(req.params.articleId) as { id: string; translatorSlots: number; targetLanguage: string } | undefined;
  if (!found) { res.status(404).json({ error: '文章不存在' }); return; }
  if (parsed.data.targetLanguage && parsed.data.targetLanguage !== found.targetLanguage) {
    res.status(409).json({ error: '文章导入后不能更换目标语种，以免已有任务、预译和译文发生错配；请按新语种重新导入文章' }); return;
  }
  db.transaction(() => {
    db.prepare("UPDATE articles SET translator_slots=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(parsed.data.translatorSlots, req.params.articleId);
    db.prepare('UPDATE sentences SET translator_slots=? WHERE article_id=?').run(parsed.data.translatorSlots, req.params.articleId);
  }).immediate();
  const article = articleViews(db, found.id)[0];
  audit(req, 'admin.article.config', 'article', found.id, {
    before: { translatorSlots: found.translatorSlots, targetLanguage: found.targetLanguage },
    after: { translatorSlots: parsed.data.translatorSlots, targetLanguage: found.targetLanguage },
    preservedAssignments: article.assignmentCount, overCapacitySentenceCount: article.overCapacitySentenceCount,
  });
  res.json({ article });
});

app.get('/api/admin/articles/:articleId/source-url', adminOnly, asyncRoute(async (req, res) => {
  const article = db.prepare('SELECT source_object_key as sourceObjectKey FROM articles WHERE id=?').get(req.params.articleId) as { sourceObjectKey: string | null } | undefined;
  if (!article) { res.status(404).json({ error: '文章不存在' }); return; }
  if (!article.sourceObjectKey) { res.status(404).json({ error: '该文章没有保存原始文件' }); return; }
  const url = await sourceFileUrl(article.sourceObjectKey);
  if (!url) { res.status(503).json({ error: '对象存储未配置' }); return; }
  audit(req, 'admin.article.source_url', 'article', String(req.params.articleId));
  res.json({ url, expiresIn: 900 });
}));

// Call inside an IMMEDIATE transaction shared by the complete allocation batch.
function allocateAssignments(userId: string, articleId: string | null, count: number): string[] {
  const rows = db.prepare(`SELECT s.id FROM sentences s JOIN articles a ON a.id=s.article_id
    WHERE (? IS NULL OR a.id=?)
      AND NOT EXISTS (SELECT 1 FROM assignments mine WHERE mine.sentence_id=s.id AND mine.user_id=?)
      AND NOT EXISTS (SELECT 1 FROM translations accepted WHERE accepted.sentence_id=s.id AND accepted.status='accepted')
      AND (SELECT COUNT(*) FROM assignments all_assignments WHERE all_assignments.sentence_id=s.id) < MAX(s.translator_slots, 1)
    ORDER BY RANDOM() LIMIT ?`).all(articleId, articleId, userId, count) as Array<{ id: string }>;
  const add = db.prepare('INSERT INTO assignments (id,sentence_id,user_id) VALUES (?,?,?)');
  return rows.map(row => { const assignmentId = id(); add.run(assignmentId, row.id, userId); return assignmentId; });
}

app.post('/api/admin/articles/:articleId/assign', adminOnly, writeLimiter, (req, res) => {
  const parsed = z.object({ userIds: z.array(uuidSchema).min(1).max(50).refine(ids => new Set(ids).size === ids.length), count: z.number().int().min(1).max(2) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: '请选择 1-50 位不同的志愿者，每人分配 1 或 2 句' }); return; }
  const articleId = String(req.params.articleId);
  if (!db.prepare('SELECT id FROM articles WHERE id=?').get(articleId)) { res.status(404).json({ error: '文章不存在' }); return; }
  const outcome = db.transaction(() => {
    const users = db.prepare(`SELECT id,name FROM users WHERE id IN (${parsed.data.userIds.map(() => '?').join(',')})`).all(...parsed.data.userIds) as Array<{ id: string; name: string }>;
    if (users.length !== parsed.data.userIds.length) return null;
    const names = new Map(users.map(user => [user.id, user.name]));
    return parsed.data.userIds.map(userId => {
      const claimedIds = new Set(allocateAssignments(userId, articleId, parsed.data.count));
      const assignments = taskViews(db, { userId }).filter(task => claimedIds.has(task.id));
      return { userId, userName: names.get(userId), assignedCount: assignments.length, assignments,
        skippedReason: assignments.length === parsed.data.count ? null : assignments.length > 0
          ? `仅有 ${assignments.length} 句可分配，其余句子已领取、名额已满或已结束`
          : '该志愿者没有可分配句子：已领取、名额已满或文章任务已结束',
      };
    });
  }).immediate();
  if (!outcome) { res.status(400).json({ error: '部分志愿者不存在，请刷新名单后重新分配' }); return; }
  const assignedCount = outcome.reduce((sum, result) => sum + result.assignedCount, 0);
  audit(req, 'admin.article.assign', 'article', articleId, { userIds: parsed.data.userIds, count: parsed.data.count, assignedCount });
  res.json({ results: outcome, assignedCount, totalRequested: parsed.data.userIds.length * parsed.data.count, article: articleViews(db, articleId)[0] });
});

app.post('/api/assignments/request', translatorOnly, writeLimiter, asyncRoute(async (req, res) => {
  const parsed = z.object({ userId: uuidSchema, articleId: uuidSchema.optional(), count: z.coerce.number().int().min(1).max(2).default(2) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'userId 必填，count 只能为 1 或 2', details: parsed.error.flatten() }); return; }
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(parsed.data.userId)) { res.status(404).json({ error: '用户不存在' }); return; }
  if (parsed.data.articleId && !db.prepare('SELECT id FROM articles WHERE id=?').get(parsed.data.articleId)) { res.status(404).json({ error: '文章不存在' }); return; }
  // Selection and insertion must share one write transaction, otherwise concurrent
  // requests can both observe free slots and over-allocate a sentence.
  const claimedIds = new Set(db.transaction(() => allocateAssignments(parsed.data.userId, parsed.data.articleId || null, parsed.data.count)).immediate());
  const assignments = taskViews(db, { userId: parsed.data.userId }).filter(task => claimedIds.has(task.id));
  audit(req, 'translator.assignment.request', 'article', parsed.data.articleId || null, { count: assignments.length });
  res.json({ assignments, available: assignments.length });
}));

app.get('/api/users/:userId/tasks', translatorOnly, asyncRoute(async (req, res) => {
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(req.params.userId)) { res.status(404).json({ error: '用户不存在' }); return; }
  const tasks = taskViews(db, { userId: String(req.params.userId) });
  for (const task of tasks) if (!task.closed && !task.translationSuggestion) void scheduleSuggestion(task.sentenceId).catch(() => console.error('pretranslate scheduling failed'));
  res.json({ tasks: taskViews(db, { userId: String(req.params.userId) }) });
}));

app.get('/api/me/tasks', translatorOnly, asyncRoute(async (req, res) => {
  const userId = String(req.query.userId || req.header('x-user-id') || '');
  if (!userId) { res.status(400).json({ error: '请提供 userId 或 x-user-id' }); return; }
  res.redirect(307, `/api/users/${encodeURIComponent(userId)}/tasks`);
}));

app.get('/api/assignments/:assignmentId', asyncRoute(async (req, res) => {
  const session = currentSession(req, 'translator');
  if (!session || session.role !== 'translator' || !session.userId) { res.status(401).json({ error: '请先登录译者账号' }); return; }
  const assignment = taskViews(db, { assignmentId: String(req.params.assignmentId) })[0];
  if (!assignment) { res.status(404).json({ error: '任务不存在' }); return; }
  if (assignment.userId !== session.userId) { res.status(403).json({ error: '只能访问自己的任务' }); return; }
  if (!assignment.closed && !assignment.translationSuggestion) void scheduleSuggestion(assignment.sentenceId).catch(() => console.error('pretranslate scheduling failed'));
  res.json({ assignment: taskViews(db, { assignmentId: String(req.params.assignmentId) })[0] });
}));

app.get('/api/assignments/:assignmentId/history', translatorOnly, (req, res) => {
  const assignment = taskViews(db, { assignmentId: String(req.params.assignmentId) })[0];
  if (!assignment) { res.status(404).json({ error: '任务不存在' }); return; }
  if (assignment.userId !== currentSession(req, 'translator')?.userId) { res.status(403).json({ error: '只能访问自己的任务' }); return; }
  res.json({ history: assignment.translationId ? translationHistory(db, String(assignment.translationId)) : [] });
});

app.post('/api/assignments/:assignmentId/submit', translatorOnly, writeLimiter, (req, res) => {
  const parsed = z.object({ userId: uuidSchema, content: z.string().trim().min(1).max(10000), expectedRevision: z.number().int().min(0).optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'userId 与翻译内容必填', details: parsed.error.flatten() }); return; }
  const assignment = db.prepare('SELECT id,sentence_id as sentenceId,user_id as userId,status FROM assignments WHERE id=?').get(req.params.assignmentId) as { id: string; sentenceId: string; userId: string; status: string } | undefined;
  if (!assignment) { res.status(404).json({ error: '任务不存在' }); return; }
  if (assignment.userId !== parsed.data.userId) { res.status(403).json({ error: '只能提交自己的任务' }); return; }
  let translationId = id();
  const submissionError = db.transaction(() => {
    const accepted = db.prepare("SELECT user_id as userId FROM translations WHERE sentence_id=? AND status='accepted'").get(assignment.sentenceId) as { userId: string } | undefined;
    if (accepted) return accepted.userId === parsed.data.userId
      ? '你的译文已采纳，不能再次提交'
      : '该句已有采纳译文，本任务已结束，请领取其他句子';
    const current = db.prepare('SELECT status FROM assignments WHERE id=?').get(assignment.id) as { status: string };
    if (current.status === 'done') return '该任务已结束，不能再次提交';
    const prior = db.prepare('SELECT id,status,revision FROM translations WHERE sentence_id=? AND user_id=?').get(assignment.sentenceId, parsed.data.userId) as { id: string; status: string; revision: number } | undefined;
    if (prior && parsed.data.expectedRevision === undefined) return '重新提交需要当前译文版本，请刷新后再提交';
    if (parsed.data.expectedRevision !== undefined && parsed.data.expectedRevision !== (prior?.revision || 0)) return '译文版本已更新，请刷新后重新提交';
    if (prior?.status === 'pending') return '译文正在审核中，不能重复提交或覆盖；退回后可修改';
    if (prior && prior.status !== 'rejected') return '当前译文不能重新提交';
    if (prior) {
      translationId = prior.id;
      db.prepare(`UPDATE translations SET content=?,status='pending',revision=revision+1,created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),reviewed_at=NULL,review_note=NULL WHERE id=?`).run(parsed.data.content, prior.id);
    } else {
      db.prepare(`INSERT INTO translations (id,sentence_id,user_id,content,status) VALUES (?,?,?,?,'pending')`).run(translationId, assignment.sentenceId, parsed.data.userId, parsed.data.content);
    }
    db.prepare(`INSERT INTO translation_versions (translation_id,revision,content,review_status,submitted_at)
      SELECT id,revision,content,'pending',created_at FROM translations WHERE id=?`).run(translationId);
    db.prepare("UPDATE assignments SET status='submitted' WHERE id=?").run(req.params.assignmentId);
    return null;
  }).immediate();
  if (submissionError) { res.status(409).json({ error: submissionError }); return; }
  const translation = translationView(db, translationId);
  audit(req, 'translator.translation.submit', 'assignment', String(req.params.assignmentId), { sentenceId: assignment.sentenceId });
  res.status(201).json({ translation });
});

app.post('/api/admin/sentences/:sentenceId/pretranslate', adminOnly, writeLimiter, asyncRoute(async (req, res) => {
  const sentence = sentenceView(String(req.params.sentenceId)) as { id: string; sourceText: string; targetLanguage: string; translationSuggestion: string | null; suggestionStatus: string; suggestionRetryAt: number | null } | undefined;
  if (!sentence) { res.status(404).json({ error: '句子不存在' }); return; }
  if (!sentence.translationSuggestion && sentence.suggestionStatus === 'failed' && sentence.suggestionRetryAt && sentence.suggestionRetryAt > Date.now()) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((sentence.suggestionRetryAt - Date.now()) / 1000))));
    res.status(429).json({ error: '模型冷却中，请稍后重试', accepted: false, sentence, provider: getModelConfiguration().provider });
    return;
  }
  void suggestions.schedule(sentence.id, true).catch(() => console.error('pretranslate scheduling failed'));
  audit(req, 'admin.pretranslate.retry', 'sentence', sentence.id);
  res.status(sentence.translationSuggestion ? 200 : 202).json({ sentence: sentenceView(sentence.id), provider: getModelConfiguration().provider });
}));

app.get('/api/admin/translations', adminOnly, (req, res) => {
  const filterStatus = req.query.reviewStatus ?? req.query.status;
  if (filterStatus !== undefined && !['all', 'pending', 'accepted', 'rejected', 'returned', 'not_selected'].includes(String(filterStatus))) {
    res.status(400).json({ error: '审核状态不正确' }); return;
  }
  audit(req, 'admin.translations.list', 'translation', null, { status: filterStatus || 'all', articleId: req.query.articleId || 'all', userId: req.query.userId || 'all' });
  const status = filterStatus && filterStatus !== 'all' ? String(filterStatus) : null;
  const articleId = typeof req.query.articleId === 'string' ? req.query.articleId : null;
  const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
  const entryCode = typeof req.query.entryCode === 'string' && req.query.entryCode.trim() ? req.query.entryCode.trim() : null;
  const translations = db.prepare(`SELECT t.id,t.content,t.status,t.created_at as createdAt,t.reviewed_at as reviewedAt,
      ${reviewFieldsSql()},
      u.id as userId,u.name as userName,s.id as sentenceId,s.position,s.source_text as sourceText,
      s.translator_slots as translatorSlots,s.translation_suggestion as translationSuggestion,
      s.suggestion_status as suggestionStatus,s.suggestion_error as suggestionError,s.suggestion_retry_at as suggestionRetryAt,
      a.id as articleId,a.title,a.title AS articleTitle,a.task_unit as taskUnit,a.source_language as sourceLanguage,a.target_language as targetLanguage,
      u.entry_id as entryId,e.code as entryCode,e.name as entryName,e.channel as entryChannel
    FROM translations t JOIN users u ON u.id=t.user_id LEFT JOIN entry_points e ON e.id=u.entry_id JOIN sentences s ON s.id=t.sentence_id JOIN articles a ON a.id=s.article_id
    WHERE (? IS NULL OR ${status === 'rejected' ? 't.status' : reviewStatusSql()}=?)
      AND (? IS NULL OR a.id=?) AND (? IS NULL OR u.id=?) AND (? IS NULL OR e.code=?)
    ORDER BY t.created_at DESC,t.id`).all(status, status, articleId, articleId, userId, userId, entryCode, entryCode);
  res.json({ translations });
});

app.get('/api/admin/translations/:translationId/history', adminOnly, (req, res) => {
  if (!db.prepare('SELECT id FROM translations WHERE id=?').get(req.params.translationId)) { res.status(404).json({ error: '译文不存在' }); return; }
  res.json({ history: translationHistory(db, String(req.params.translationId)) });
});

app.post('/api/admin/translations/:translationId/review', adminOnly, writeLimiter, (req, res) => {
  const parsed = z.object({ decision: z.enum(['accepted', 'returned', 'rejected']),
    reviewNote: z.string().trim().max(1000).optional(), reason: z.string().trim().max(1000).optional(),
    expectedRevision: z.number().int().min(1).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: '请选择采纳或退回，退回原因最多 1000 字，版本号必须为正整数' }); return; }
  const decision = parsed.data.decision === 'accepted' ? 'accepted' : 'returned';
  const reviewNote = parsed.data.reviewNote || parsed.data.reason || null;
  if (decision === 'returned' && !reviewNote) { res.status(400).json({ error: '请填写退回原因和修改建议（1-1000 字）' }); return; }
  const translation = db.prepare('SELECT id,sentence_id as sentenceId,user_id as userId FROM translations WHERE id=?').get(req.params.translationId) as { id: string; sentenceId: string; userId: string } | undefined;
  if (!translation) { res.status(404).json({ error: '译文不存在' }); return; }
  const reviewError = db.transaction(() => {
    const current = db.prepare('SELECT status,revision FROM translations WHERE id=?').get(translation.id) as { status: string; revision: number };
    if (current.revision > 1 && parsed.data.expectedRevision === undefined) return '重译稿件审核需要当前版本，请刷新后再审核';
    if (parsed.data.expectedRevision !== undefined && parsed.data.expectedRevision !== current.revision) return '译文版本已更新，请刷新后再审核';
    if (current.status === 'accepted') return '已采纳译文不能重复审核或退回';
    if (current.status !== 'pending') return '该译文已处理，请刷新后再审核';
    const another = db.prepare("SELECT id FROM translations WHERE sentence_id=? AND id<>? AND status='accepted'").get(translation.sentenceId, translation.id);
    if (another) return '该句段已有采纳译文';
    db.prepare("UPDATE translations SET status=?,review_note=?,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(decision === 'accepted' ? 'accepted' : 'rejected', reviewNote, translation.id);
    db.prepare(`UPDATE translation_versions SET review_status=?,review_note=?,reviewed_at=(SELECT reviewed_at FROM translations WHERE id=?)
      WHERE translation_id=? AND revision=?`).run(decision, reviewNote, translation.id, translation.id, current.revision);
    if (decision === 'accepted') {
      // A returned version keeps its original review in history; a pending
      // competing version is archived explicitly as not selected.
      db.prepare(`UPDATE translation_versions SET review_status='not_selected',reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE review_status='pending' AND EXISTS (SELECT 1 FROM translations t WHERE t.id=translation_versions.translation_id
          AND t.revision=translation_versions.revision AND t.sentence_id=? AND t.id<>?)`).run(translation.sentenceId, translation.id);
      db.prepare("UPDATE translations SET status='rejected',review_note=NULL,reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE sentence_id=? AND id<>? AND status<>'accepted'").run(translation.sentenceId, translation.id);
      db.prepare("UPDATE assignments SET status='done' WHERE sentence_id=?").run(translation.sentenceId);
    } else {
      db.prepare("UPDATE assignments SET status='assigned' WHERE sentence_id=? AND user_id=?").run(translation.sentenceId, translation.userId);
    }
    return null;
  }).immediate();
  if (reviewError) { res.status(409).json({ error: reviewError }); return; }
  audit(req, `admin.translation.${decision}`, 'translation', translation.id, { sentenceId: translation.sentenceId, userId: translation.userId, expectedRevision: parsed.data.expectedRevision });
  res.json({ translation: translationView(db, translation.id) });
});

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

app.get('/api/admin/reports/export.csv', adminOnly, (req, res) => {
  audit(req, 'admin.report.export', 'report', null, { articleId: req.query.articleId || 'all', entryCode: req.query.entryCode || 'all' });
  const articleId = typeof req.query.articleId === 'string' ? req.query.articleId : null;
  const entryCode = typeof req.query.entryCode === 'string' && req.query.entryCode.trim() ? req.query.entryCode.trim() : null;
  const rows = db.prepare(`SELECT a.title as articleTitle,s.position,s.source_text as sourceText,
      t.content,t.status,${reviewFieldsSql()},t.created_at as createdAt,t.reviewed_at as reviewedAt,u.name as userName,
      e.code as entryCode,e.name as entryName
    FROM translations t JOIN sentences s ON s.id=t.sentence_id JOIN articles a ON a.id=s.article_id
    JOIN users u ON u.id=t.user_id LEFT JOIN entry_points e ON e.id=u.entry_id
    WHERE (? IS NULL OR a.id=?) AND (? IS NULL OR e.code=?) ORDER BY a.created_at DESC,s.position,t.created_at ASC`).all(articleId, articleId, entryCode, entryCode) as Array<Record<string, unknown>>;
  const header = ['文章', '句序', '原文', '译文', '状态', '译者', '入口编码', '入口名称', '提交时间', '审核时间', '版本', '审核意见'];
  const statusNames: Record<string, string> = { pending: '待审核', accepted: '已采纳', returned: '退回重译', not_selected: '未采纳' };
  const lines = rows.map((row) => [row.articleTitle, row.position, row.sourceText, row.content, statusNames[String(row.reviewStatus)], row.userName, row.entryCode, row.entryName, row.createdAt, row.reviewedAt, row.revision, row.reviewNote].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="translation-report-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`\ufeff${header.join(',')}\n${lines.join('\n')}`);
});

app.get('/api/admin/reports', adminOnly, (req, res) => {
  audit(req, 'admin.report.read', 'report', null, { articleId: req.query.articleId || 'all', entryCode: req.query.entryCode || 'all' });
  const articleId = typeof req.query.articleId === 'string' ? req.query.articleId : null;
  const entryCode = typeof req.query.entryCode === 'string' && req.query.entryCode.trim() ? req.query.entryCode.trim() : null;
  const where = `WHERE (? IS NULL OR a.id=?) AND (? IS NULL OR ex.code=? OR et.code=?)`;
  const args = [articleId, articleId, entryCode, entryCode, entryCode];
  const totals = db.prepare(`SELECT COUNT(DISTINCT s.id) as sentenceCount,
    COUNT(DISTINCT CASE WHEN x.id IS NOT NULL THEN s.id END) as assignedSentenceCount,
    COUNT(DISTINCT t.id) as translationCount,
    COUNT(DISTINCT CASE WHEN t.status='accepted' THEN s.id END) as acceptedSentenceCount,
    COUNT(DISTINCT CASE WHEN t.status='pending' THEN t.id END) as pendingTranslationCount,
    COUNT(DISTINCT CASE WHEN ${reviewStatusSql()}='returned' THEN t.id END) as returnedTranslationCount,
    COUNT(DISTINCT CASE WHEN ${reviewStatusSql()}='not_selected' THEN t.id END) as notSelectedTranslationCount
    FROM articles a LEFT JOIN sentences s ON s.article_id=a.id LEFT JOIN assignments x ON x.sentence_id=s.id
    LEFT JOIN users ux ON ux.id=x.user_id LEFT JOIN entry_points ex ON ex.id=ux.entry_id
    LEFT JOIN translations t ON t.sentence_id=s.id LEFT JOIN users ut ON ut.id=t.user_id LEFT JOIN entry_points et ON et.id=ut.entry_id ${where}`).get(...args);
  const translators = db.prepare(`SELECT u.id as userId,u.name,
      COUNT(DISTINCT CASE WHEN ${articleId ? 'a.id=?' : '1=1'} THEN x.id END) as assignedCount,
      COUNT(DISTINCT CASE WHEN ${articleId ? 'a.id=?' : '1=1'} THEN t.id END) as submittedCount,
      COUNT(DISTINCT CASE WHEN ${articleId ? 'a.id=? AND t.status=\'accepted\'' : "t.status='accepted'"} THEN t.id END) as acceptedCount,
      COUNT(DISTINCT CASE WHEN ${articleId ? 'a.id=? AND' : ''} t.status='pending' THEN t.id END) as pendingCount,
      COUNT(DISTINCT CASE WHEN ${articleId ? 'a.id=? AND' : ''} ${reviewStatusSql()}='returned' THEN t.id END) as returnedCount,
      COUNT(DISTINCT CASE WHEN ${articleId ? 'a.id=? AND' : ''} ${reviewStatusSql()}='not_selected' THEN t.id END) as notSelectedCount
    FROM users u LEFT JOIN entry_points e ON e.id=u.entry_id LEFT JOIN assignments x ON x.user_id=u.id LEFT JOIN sentences s ON s.id=x.sentence_id LEFT JOIN articles a ON a.id=s.article_id
    LEFT JOIN translations t ON t.user_id=u.id AND t.sentence_id=s.id
    WHERE (? IS NULL OR e.code=?) GROUP BY u.id ORDER BY acceptedCount DESC,submittedCount DESC`).all(...(articleId ? [...Array(6).fill(articleId), entryCode, entryCode] : [entryCode, entryCode]));
  const acceptedBySentence = db.prepare(`SELECT s.id as sentenceId,s.position,s.source_text as sourceText,
      t.id as translationId,t.content,t.created_at as createdAt,u.id as userId,u.name as userName,
      e.code as entryCode,e.name as entryName
    FROM sentences s JOIN articles a ON a.id=s.article_id
    JOIN translations t ON t.sentence_id=s.id AND t.status='accepted'
    JOIN users u ON u.id=t.user_id LEFT JOIN entry_points e ON e.id=u.entry_id
    WHERE (? IS NULL OR a.id=?) AND (? IS NULL OR e.code=?) ORDER BY a.created_at DESC,s.position`).all(articleId, articleId, entryCode, entryCode);
  res.json({ scope: articleId || 'all', entryCode: entryCode || 'all', totals, translators, acceptedBySentence });
});

app.use((_req, res) => res.status(404).json({ error: '接口不存在' }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 20MB' : '上传文件格式或字段不正确';
    res.status(400).json({ error: message });
    return;
  }
  const statusCode = typeof error === 'object' && error && 'statusCode' in error ? Number((error as { statusCode: number }).statusCode) : 500;
  if (statusCode >= 400 && statusCode < 500) { res.status(statusCode).json({ error: (error as Error).message }); return; }
  console.error('request failed', error instanceof Error ? error.message : 'unknown error');
  res.status(500).json({ error: '服务器内部错误' });
});

const server = app.listen(port, () => {
  console.log(`translation backend listening on :${port}`);
  suggestions.start();
  if (queueConfigured()) {
    void startPretranslateWorker(suggestions.generate).catch((error) => {
      console.error('pretranslate worker failed to start', error instanceof Error ? error.message : 'unknown error');
    });
  }
});
server.requestTimeout = 120_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;

server.once('close', () => { void suggestions.close(); });

function shutdown() {
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(() => {
    void closeQueue().then(() => suggestions.close()).finally(() => { clearTimeout(forceExit); db.close(); process.exit(0); });
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, db, server, suggestions };
