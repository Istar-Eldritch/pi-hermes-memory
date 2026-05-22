import { DatabaseManager } from './db.js';
import { escapeFts5Query, temporalDecay, tokenizeForJaccard, jaccard } from './fts-utils.js';
import { encodeText, phasesToBytes, bytesToPhases, similarity as hrrSimilarity, DEFAULT_HRR_DIM } from './hrr.js';

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
  /** Temporal decay half-life in days. 0 disables decay (default: 60). */
  temporalDecayHalfLifeDays?: number;
  /** Weight of normalised BM25 (FTS rank). Default 1. */
  ftsWeight?: number;
  /** Weight of Jaccard token overlap. Default 0.5. */
  jaccardWeight?: number;
  /** Weight of HRR cosine similarity. Default 0 (disabled). */
  hrrWeight?: number;
  /** Max non-FTS HRR candidates fetched in stage 2 (default 500). */
  hrrCandidateCap?: number;
  /** When true, scale score by log(1 + accesses/day). Default false. */
  frequencyBoost?: boolean;
  /** Drop candidates whose relevance is below this threshold (default 0). */
  minScore?: number;
  /** When true, bump reference_count/last_referenced for returned rows. */
  touch?: boolean;
}

type CandidateRow = {
  message_rowid: number;
  message_id: string;
  session_id: string;
  project: string;
  role: string;
  content: string;
  timestamp: string;
  reference_count: number;
  hrr_vector: Buffer | null;
  hrr_dim: number | null;
  fts_rank: number | null;
};

/**
 * Search across indexed session messages using FTS5, with optional
 * Jaccard/HRR reranking, temporal decay, and frequency boost. Mirrors the
 * scoring pipeline in searchMemories.
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
    hrrWeight = 0,
    hrrCandidateCap = 500,
    frequencyBoost = false,
    minScore = 0,
    touch = false,
  } = options;

  const filterClauses: string[] = [];
  const filterParams: unknown[] = [];
  if (project) {
    filterClauses.push('s.project = ?');
    filterParams.push(project);
  }
  if (role) {
    filterClauses.push('m.role = ?');
    filterParams.push(role);
  }
  if (since) {
    filterClauses.push('m.timestamp >= ?');
    filterParams.push(since);
  }

  const reranking = temporalDecayHalfLifeDays > 0 || jaccardWeight > 0 || hrrWeight > 0 || frequencyBoost;
  const candidateLimit = reranking ? Math.max(limit * 3, limit) : limit;

  // Stage 1: FTS5 candidates with implicit AND across query terms.
  const ftsConditions = ['m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)', ...filterClauses];
  const ftsSql = `
    SELECT
      m.rowid AS message_rowid,
      m.id AS message_id,
      m.session_id,
      s.project,
      m.role,
      m.content,
      m.timestamp,
      m.reference_count,
      m.hrr_vector,
      m.hrr_dim,
      (SELECT rank FROM message_fts WHERE message_fts MATCH ? AND rowid = m.rowid) AS fts_rank
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE ${ftsConditions.join(' AND ')}
    ORDER BY fts_rank
    LIMIT ?
  `;
  const ftsQuery = escapeFts5Query(query);
  let ftsRows: CandidateRow[];
  try {
    ftsRows = db.prepare(ftsSql).all(ftsQuery, ftsQuery, ...filterParams, candidateLimit) as CandidateRow[];
  } catch {
    return [];
  }

  // Stage 2 (HRR only): pull additional candidates with no FTS overlap.
  let extraRows: CandidateRow[] = [];
  if (hrrWeight > 0) {
    const seen = new Set(ftsRows.map((r) => r.message_rowid));
    const where = ['m.hrr_vector IS NOT NULL', ...filterClauses];
    const hrrSql = `
      SELECT
        m.rowid AS message_rowid,
        m.id AS message_id,
        m.session_id,
        s.project,
        m.role,
        m.content,
        m.timestamp,
        m.reference_count,
        m.hrr_vector,
        m.hrr_dim,
        NULL AS fts_rank
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `;
    const all = db.prepare(hrrSql).all(...filterParams, hrrCandidateCap) as CandidateRow[];
    extraRows = all.filter((r) => !seen.has(r.message_rowid));
  }

  const rows = [...ftsRows, ...extraRows];
  if (rows.length === 0) return [];

  if (!reranking) {
    const sliced = rows.slice(0, limit);
    if (touch) touchMessages(dbManager, sliced.map((r) => r.message_rowid));
    return sliced.map(toResult);
  }

  const ftsRanks = ftsRows.map((r) => Math.abs(r.fts_rank ?? 0));
  const maxRank = Math.max(...ftsRanks, 1e-6);

  const now = Date.now();
  const rawFreqs = rows.map((r) => {
    const ageDays = Math.max(1, (now - Date.parse(r.timestamp)) / 86_400_000);
    return Math.log1p(r.reference_count / ageDays);
  });
  const maxFreq = Math.max(...rawFreqs, 1e-6);

  const queryTokens = jaccardWeight > 0 ? tokenizeForJaccard(query) : null;
  const hrrDimUsed = rows.find((r) => r.hrr_dim)?.hrr_dim ?? DEFAULT_HRR_DIM;
  const queryHrr = hrrWeight > 0 ? encodeText(query, hrrDimUsed) : null;
  const totalWeight = Math.max(ftsWeight + jaccardWeight + hrrWeight, 1e-9);

  const ranked = rows
    .map((r, i) => {
      const normFts = r.fts_rank != null ? Math.abs(r.fts_rank) / maxRank : 0;
      const jacc = queryTokens ? jaccard(queryTokens, tokenizeForJaccard(r.content)) : 0;
      let hrrSim = 0;
      if (queryHrr && r.hrr_vector && r.hrr_dim === queryHrr.length) {
        const v = bytesToPhases(r.hrr_vector);
        hrrSim = (hrrSimilarity(queryHrr, v) + 1) / 2;
      }
      const relevance = (ftsWeight * normFts + jaccardWeight * jacc + hrrWeight * hrrSim) / totalWeight;
      const decay = temporalDecay(r.timestamp, temporalDecayHalfLifeDays);
      const freq = frequencyBoost ? rawFreqs[i] / maxFreq : 1.0;
      return { row: r, score: relevance * decay * freq, relevance };
    })
    .filter((s) => s.relevance >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (touch) touchMessages(dbManager, ranked.map((s) => s.row.message_rowid));

  return ranked.map(({ row }) => toResult(row));
}

function toResult(row: CandidateRow): SessionSearchResult {
  return {
    sessionId: row.session_id,
    project: row.project,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    snippet: row.content,
  };
}

/** Bump reference_count and last_referenced for messages returned by search. */
export function touchMessages(dbManager: DatabaseManager, rowids: number[]): void {
  if (rowids.length === 0) return;
  const db = dbManager.getDb();
  const stmt = db.prepare(
    'UPDATE messages SET reference_count = reference_count + 1, last_referenced = ? WHERE rowid = ?'
  );
  const nowIso = new Date().toISOString();
  const run = () => {
    for (const id of rowids) stmt.run(nowIso, id);
  };
  if (db.transaction) {
    db.transaction(run)();
  } else {
    run();
  }
}

/**
 * Backfill HRR vectors for any message rows that don't have one yet (or
 * that were encoded at a different dimension). Safe to call repeatedly.
 */
export function backfillMessageHrrVectors(
  dbManager: DatabaseManager,
  hrrDim: number = DEFAULT_HRR_DIM,
  onProgress?: (processed: number, total: number) => void,
): number {
  const db = dbManager.getDb();
  const rows = db.prepare(
    'SELECT rowid AS rowid, content FROM messages WHERE hrr_vector IS NULL OR hrr_dim IS NULL OR hrr_dim != ?'
  ).all(hrrDim) as Array<{ rowid: number; content: string }>;
  if (rows.length === 0) return 0;
  const update = db.prepare('UPDATE messages SET hrr_vector = ?, hrr_dim = ? WHERE rowid = ?');
  let n = 0;
  let processed = 0;
  for (const row of rows) {
    try {
      const vec = phasesToBytes(encodeText(row.content, hrrDim));
      update.run(vec, hrrDim, row.rowid);
      n++;
    } catch {
      // skip
    }
    processed++;
    if (onProgress) onProgress(processed, rows.length);
  }
  return n;
}

/**
 * Get the total number of indexed messages.
 */
export function getIndexedMessageCount(dbManager: DatabaseManager): number {
  const db = dbManager.getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  return result.count;
}
