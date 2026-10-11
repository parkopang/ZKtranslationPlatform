import type { DB } from './db.js';

// Aggregate each child table before joining it. Joining assignments directly to
// translations would multiply both counts when several volunteers work on a sentence.
const sentenceStats = `WITH sentence_stats AS (
  SELECT s.*,
    (SELECT COUNT(*) FROM assignments x WHERE x.sentence_id=s.id) AS assignment_count,
    (SELECT COUNT(*) FROM translations t WHERE t.sentence_id=s.id) AS translation_count,
    (SELECT COUNT(*) FROM translations t WHERE t.sentence_id=s.id AND t.status='pending') AS pending_translation_count,
    (SELECT COUNT(*) FROM translations t WHERE t.sentence_id=s.id AND t.status='accepted') AS accepted_count,
    (SELECT COUNT(*) FROM translations t JOIN assignments x ON x.sentence_id=t.sentence_id AND x.user_id=t.user_id
      WHERE t.sentence_id=s.id AND t.status='rejected' AND x.status<>'done'
      AND NOT EXISTS (SELECT 1 FROM translations winner WHERE winner.sentence_id=s.id AND winner.status='accepted')) AS returned_translation_count,
    (SELECT COUNT(*) FROM assignments x WHERE x.sentence_id=s.id AND x.status='assigned') AS unsubmitted_count
  FROM sentences s WHERE (? IS NULL OR s.article_id=?)
)`;

export function articleViews(db: DB, articleId: string | null = null) {
  return db.prepare(`${sentenceStats}
    SELECT a.id,a.title,a.source_language AS sourceLanguage,a.target_language AS targetLanguage,
      a.source_file_name AS sourceFileName,a.source_object_key AS sourceObjectKey,
      a.source_sha256 AS sourceSha256,a.source_size AS sourceSize,
      a.task_unit AS taskUnit,
      a.translator_slots AS translatorSlots,a.created_at AS createdAt,
      COALESCE(a.updated_at,a.created_at) AS updatedAt,
      COUNT(s.id) AS sentenceCount,
      COALESCE(SUM(CASE WHEN s.accepted_count>0 THEN 1 ELSE 0 END),0) AS acceptedSentenceCount,
      COALESCE(SUM(s.translator_slots),0) AS totalCapacity,
      COALESCE(SUM(s.assignment_count),0) AS assignmentCount,
      COALESCE(SUM(s.translation_count),0) AS translationCount,
      COALESCE(SUM(s.pending_translation_count),0) AS pendingTranslationCount,
      COALESCE(SUM(s.returned_translation_count),0) AS returnedTranslationCount,
      COALESCE(SUM(CASE WHEN s.accepted_count=0 THEN s.unsubmitted_count ELSE 0 END),0) AS activeAssignments,
      COALESCE(SUM(CASE WHEN s.accepted_count=0 THEN MAX(s.translator_slots-s.assignment_count,0) ELSE 0 END),0) AS remainingSlots,
      COALESCE(SUM(CASE WHEN s.assignment_count>s.translator_slots THEN 1 ELSE 0 END),0) AS overCapacitySentenceCount
    FROM articles a LEFT JOIN sentence_stats s ON s.article_id=a.id
    WHERE (? IS NULL OR a.id=?) GROUP BY a.id ORDER BY a.created_at DESC,a.id DESC
  `).all(articleId, articleId, articleId, articleId) as Array<Record<string, unknown>>;
}

export function articleSentenceViews(db: DB, articleId: string) {
  return db.prepare(`${sentenceStats}
    SELECT id,position,source_text AS sourceText,translator_slots AS translatorSlots,
      translation_suggestion AS translationSuggestion,suggestion_status AS suggestionStatus,
      suggestion_error AS suggestionError,suggestion_retry_at AS suggestionRetryAt,
      assignment_count AS assignmentCount,translation_count AS translationCount,
      pending_translation_count AS pendingTranslationCount,accepted_count AS acceptedCount,
      returned_translation_count AS returnedTranslationCount,
      CASE WHEN accepted_count=0 THEN unsubmitted_count ELSE 0 END AS activeAssignments,
      CASE WHEN accepted_count=0 THEN MAX(translator_slots-assignment_count,0) ELSE 0 END AS remainingSlots
    FROM sentence_stats ORDER BY position
  `).all(articleId, articleId);
}
