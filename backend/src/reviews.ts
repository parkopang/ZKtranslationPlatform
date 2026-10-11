import type { DB } from './db.js';

export const legacyReviewNote = '历史记录未保存退回原因，请联系管理员确认修改要求。';

// Keep the original SQLite status constraint intact while distinguishing a
// revision request from a sentence closed by another volunteer's accepted work.
export function reviewStatusSql(alias = 't'): string {
  return `CASE WHEN ${alias}.status='accepted' THEN 'accepted'
    WHEN ${alias}.status='pending' THEN 'pending'
    WHEN EXISTS (SELECT 1 FROM translations winner WHERE winner.sentence_id=${alias}.sentence_id AND winner.status='accepted')
      OR EXISTS (SELECT 1 FROM assignments closed WHERE closed.sentence_id=${alias}.sentence_id AND closed.user_id=${alias}.user_id AND closed.status='done')
      THEN 'not_selected' ELSE 'returned' END`;
}

export function reviewFieldsSql(alias = 't'): string {
  return `${reviewStatusSql(alias)} AS reviewStatus,${alias}.revision,
    CASE WHEN ${reviewStatusSql(alias)}='returned' THEN COALESCE(NULLIF(${alias}.review_note,''),'${legacyReviewNote}')
      ELSE ${alias}.review_note END AS reviewNote`;
}

const taskSelect = `SELECT x.id,x.user_id AS userId,x.status,x.assigned_at AS assignedAt,
    s.id AS sentenceId,s.position,s.source_text AS sourceText,s.translation_suggestion AS translationSuggestion,
    s.suggestion_status AS suggestionStatus,s.suggestion_error AS suggestionError,s.suggestion_retry_at AS suggestionRetryAt,
    a.id AS articleId,a.title,a.task_unit AS taskUnit,a.target_language AS targetLanguage,
    t.id AS translationId,t.content AS submittedContent,t.status AS translationStatus,t.reviewed_at AS reviewedAt,
    t.created_at AS submittedAt,COALESCE(t.revision,0) AS revision,
    CASE WHEN t.id IS NULL THEN NULL ELSE ${reviewStatusSql()} END AS reviewStatus,
    CASE WHEN t.id IS NOT NULL AND ${reviewStatusSql()}='returned'
      THEN COALESCE(NULLIF(t.review_note,''),'${legacyReviewNote}') ELSE t.review_note END AS reviewNote,
    (x.status='done' OR EXISTS (SELECT 1 FROM translations winner WHERE winner.sentence_id=s.id AND winner.status='accepted')) AS closed
  FROM assignments x JOIN sentences s ON s.id=x.sentence_id JOIN articles a ON a.id=s.article_id
  LEFT JOIN translations t ON t.sentence_id=s.id AND t.user_id=x.user_id`;

export type TaskView = Record<string, unknown> & {
  id: string; userId: string; sentenceId: string; status: string;
  translationSuggestion: string | null; reviewStatus: string | null; closed: boolean;
};

export function taskViews(db: DB, filter: { userId: string } | { assignmentId: string }): TaskView[] {
  const userFilter = 'userId' in filter;
  const rows = db.prepare(`${taskSelect} WHERE ${userFilter ? 'x.user_id' : 'x.id'}=? ORDER BY x.assigned_at DESC,x.id`)
    .all(userFilter ? filter.userId : filter.assignmentId) as Array<Record<string, unknown> & {
      id: string; userId: string; sentenceId: string; status: string; translationId: string | null;
      translationSuggestion: string | null; reviewStatus: string | null; closed: number;
    }>;
  return rows.map(row => ({ ...row, closed: Boolean(row.closed),
    canRevise: !row.closed && row.reviewStatus === 'returned',
    canSubmit: !row.closed && (!row.translationId || row.reviewStatus === 'returned'),
  }));
}

export function translationView(db: DB, translationId: string) {
  return db.prepare(`SELECT t.id,t.sentence_id AS sentenceId,t.user_id AS userId,t.content,t.status,
    t.created_at AS createdAt,t.reviewed_at AS reviewedAt,${reviewFieldsSql()}
    FROM translations t WHERE t.id=?`).get(translationId);
}

export function translationHistory(db: DB, translationId: string) {
  return db.prepare(`SELECT revision,content,review_status AS reviewStatus,
    CASE WHEN review_status='returned' THEN COALESCE(NULLIF(review_note,''),'${legacyReviewNote}') ELSE review_note END AS reviewNote,
    submitted_at AS submittedAt,reviewed_at AS reviewedAt
    FROM translation_versions WHERE translation_id=? ORDER BY revision DESC`).all(translationId);
}
