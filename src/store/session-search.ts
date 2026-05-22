import { DatabaseManager } from './db.js';
import { escapeFts5Query, temporalDecay, tokenizeForJaccard, jaccard } from './fts-utils.js';

/**
 * Search result from session history.
 */
export interface SessionSearchResult {
  sessionId: string;
  project: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
}

/**
 * Search options for session search.
 */
export interface SessionSearchOptions {
  /** Maximum number of results (default: 10) */
  limit?: number;
  /** Filter by project name */
  project?: string;
  /** Filter by role: 'user', 'assistant', 'system' */
  role?: string;
  /** Only return messages after this date (ISO string) */
  since?: string;
  /**
   * Temporal decay half-life in days. 0 disables decay (default: 60).
   * Older messages are downweighted but never excluded.
   */
  temporalDecayHalfLifeDays?: number;
  /** Weight of normalised BM25 (FTS rank) in the composite relevance score. */
  ftsWeight?: number;
  /** Weight of Jaccard token overlap in the composite relevance score. */
  jaccardWeight?: number;
  /** Drop candidates whose relevance is below this threshold (default: 0). */
  minScore?: number;
}

type CandidateRow = {
  session_id: string;
  project: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
  fts_rank: number;
};

/**
 * Search across indexed session messages using FTS5, with optional
 * temporal-decay and Jaccard reranking. Multi-word queries use FTS5's
 * implicit AND (all terms must appear, in any order).
 */
export function searchSessions(
  dbManager: DatabaseManager,
  query: string,
  options: SessionSearchOptions = {}
): SessionSearchResult[] {
  const db = dbManager.getDb();
  const {
    limit = 10,
    project,
    role,
    since,
    temporalDecayHalfLifeDays = 60,
    ftsWeight = 1,
    jaccardWeight = 0.5,
    minScore = 0,
  } = options;

  const conditions: string[] = ['m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)'];
  const params: unknown[] = [escapeFts5Query(query)];

  if (project) {
    conditions.push('s.project = ?');
    params.push(project);
  }
  if (role) {
    conditions.push('m.role = ?');
    params.push(role);
  }
  if (since) {
    conditions.push('m.timestamp >= ?');
    params.push(since);
  }

  const reranking = temporalDecayHalfLifeDays > 0 || jaccardWeight > 0;
  const candidateLimit = reranking ? Math.max(limit * 3, limit) : limit;

  const sql = `
    SELECT
      m.session_id,
      s.project,
      m.role,
      m.content,
      m.timestamp,
      m.content as snippet,
      (SELECT rank FROM message_fts WHERE message_fts MATCH ? AND rowid = m.rowid) AS fts_rank
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY fts_rank
    LIMIT ?
  `;
  const allParams = [escapeFts5Query(query), ...params, candidateLimit];

  let rows: CandidateRow[];
  try {
    rows = db.prepare(sql).all(...allParams) as CandidateRow[];
  } catch {
    return [];
  }

  if (rows.length === 0) return [];

  const mapped = rows.map((row) => ({
    sessionId: row.session_id,
    project: row.project,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    snippet: row.snippet,
    ftsRank: row.fts_rank,
  }));

  if (!reranking) {
    return mapped.slice(0, limit).map(({ ftsRank: _ftsRank, ...rest }) => rest);
  }

  const ftsRanks = mapped.map((r) => Math.abs(r.ftsRank ?? 0));
  const maxRank = Math.max(...ftsRanks, 1e-6);
  const queryTokens = jaccardWeight > 0 ? tokenizeForJaccard(query) : null;
  const totalWeight = Math.max(ftsWeight + jaccardWeight, 1e-9);

  return mapped
    .map((r) => {
      const normFts = r.ftsRank != null ? Math.abs(r.ftsRank) / maxRank : 0;
      const jacc = queryTokens ? jaccard(queryTokens, tokenizeForJaccard(r.content)) : 0;
      const relevance = (ftsWeight * normFts + jaccardWeight * jacc) / totalWeight;
      const decay = temporalDecay(r.timestamp, temporalDecayHalfLifeDays);
      return { row: r, score: relevance * decay, relevance };
    })
    .filter((s) => s.relevance >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => ({
      sessionId: row.sessionId,
      project: row.project,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      snippet: row.snippet,
    }));
}

/**
 * Get the total number of indexed messages.
 */
export function getIndexedMessageCount(dbManager: DatabaseManager): number {
  const db = dbManager.getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  return result.count;
}
