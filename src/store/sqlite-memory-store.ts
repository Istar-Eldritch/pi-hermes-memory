import { DatabaseManager } from './db.js';
import type { MemoryCategory } from '../types.js';
import { encodeText, phasesToBytes, bytesToPhases, similarity as hrrSimilarity, DEFAULT_HRR_DIM } from './hrr.js';
import { escapeFts5Query, temporalDecay, tokenizeForJaccard, jaccard } from './fts-utils.js';

const MEMORY_SELECT_COLUMNS = `
  id,
  project,
  target,
  category,
  content,
  failure_reason,
  tool_state,
  corrected_to,
  created,
  last_referenced,
  reference_count
`;

const FAILURE_CATEGORY_SET = new Set<MemoryCategory>([
  'failure',
  'correction',
  'insight',
  'preference',
  'convention',
  'tool-quirk',
]);

/**
 * A memory entry stored in SQLite.
 */
export interface SqliteMemoryEntry {
  id: number;
  project: string | null;
  target: 'memory' | 'user' | 'failure';
  category: MemoryCategory | null;
  content: string;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  created: string;
  lastReferenced: string;
  referenceCount: number;
}

export interface SqliteMemorySyncInput {
  content: string;
  target: 'memory' | 'user' | 'failure';
  project?: string | null;
  category?: MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  created?: string | null;
  lastReferenced?: string | null;
}

export interface SqliteMemorySyncResult {
  action: 'inserted' | 'existing';
  entry: SqliteMemoryEntry;
}

export interface SqliteMemoryUpdateResult {
  matched: number;
  updated: number;
  entries: SqliteMemoryEntry[];
}

export interface SqliteMemoryRemoveResult {
  matched: number;
  removed: number;
}

export interface SqliteMemoryRemoveOptions {
  target: 'memory' | 'user' | 'failure';
  project?: string | null;
}

export interface ParsedMarkdownMemoryEntry extends SqliteMemorySyncInput {}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function normalizeNullable(value?: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCategory(value?: MemoryCategory | null): MemoryCategory | null {
  return value ?? null;
}

function mapRow(row: {
  id: number;
  project: string | null;
  target: string;
  category: string | null;
  content: string;
  failure_reason: string | null;
  tool_state: string | null;
  corrected_to: string | null;
  created: string;
  last_referenced: string;
  reference_count: number;
}): SqliteMemoryEntry {
  return {
    id: row.id,
    project: row.project,
    target: row.target as 'memory' | 'user' | 'failure',
    category: row.category as MemoryCategory | null,
    content: row.content,
    failureReason: row.failure_reason,
    toolState: row.tool_state,
    correctedTo: row.corrected_to,
    created: row.created,
    lastReferenced: row.last_referenced,
    referenceCount: row.reference_count,
  };
}

function buildScopeConditions(params: unknown[], target?: string, project?: string | null, category?: MemoryCategory | null): string[] {
  const conditions: string[] = [];

  if (target) {
    conditions.push('target = ?');
    params.push(target);
  }

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('project = ?');
      params.push(project);
    }
  }

  if (category !== undefined) {
    if (category === null) {
      conditions.push('category IS NULL');
    } else {
      conditions.push('category = ?');
      params.push(category);
    }
  }

  return conditions;
}

function getMemoryById(dbManager: DatabaseManager, id: number): SqliteMemoryEntry | null {
  const db = dbManager.getDb();
  const row = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE id = ?
  `).get(id) as {
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
    reference_count: number;
  } | undefined;

  return row ? mapRow(row) : null;
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

function parseMetadataComment(raw: string): { text: string; created: string; lastReferenced: string } {
  const match = raw.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^>]+)\s*-->\s*$/);
  if (match) {
    return {
      text: match[1].trim(),
      created: match[2].trim(),
      lastReferenced: match[3].trim(),
    };
  }

  const fallback = today();
  return {
    text: raw.trim(),
    created: fallback,
    lastReferenced: fallback,
  };
}

/**
 * Add a memory entry to the SQLite store.
 */
export function addMemory(
  dbManager: DatabaseManager,
  content: string,
  target: 'memory' | 'user' | 'failure' = 'memory',
  project: string | null = null,
  category: MemoryCategory | null = null,
  failureReason: string | null = null,
  toolState: string | null = null,
  correctedTo: string | null = null,
  created = today(),
  lastReferenced = created,
  hrrDim: number = DEFAULT_HRR_DIM
): SqliteMemoryEntry {
  const db = dbManager.getDb();

  let hrrVector: Buffer | null = null;
  try {
    hrrVector = phasesToBytes(encodeText(content, hrrDim));
  } catch {
    hrrVector = null;
  }

  const result = db.prepare(`
    INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced, hrr_vector, hrr_dim)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced, hrrVector, hrrVector ? hrrDim : null);

  return {
    id: Number(result.lastInsertRowid),
    project,
    target,
    category,
    content,
    failureReason,
    toolState,
    correctedTo,
    created,
    lastReferenced,
    referenceCount: 1,
  };
}

/**
 * Build the visible failure-memory text stored in Markdown.
 */
export function formatFailureMemoryContent(
  content: string,
  options: {
    category: MemoryCategory;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    project?: string | null;
  }
): string {
  const categoryTag = `[${options.category}]`;
  const parts = [`${categoryTag} ${content.trim()}`.trim()];
  if (options.failureReason) parts.push(`Failed: ${options.failureReason}`);
  if (options.toolState) parts.push(`Tool state: ${options.toolState}`);
  if (options.correctedTo) parts.push(`Corrected to: ${options.correctedTo}`);
  if (options.project) parts.push(`Project: ${options.project}`);
  return parts.join(' — ');
}

/**
 * Parse a Markdown memory entry into SQLite sync fields.
 * Best-effort only: if failure metadata cannot be fully reconstructed,
 * content is still imported and available for search.
 */
export function parseMarkdownMemoryEntry(
  rawEntry: string,
  target: 'memory' | 'user' | 'failure',
  project: string | null = null,
): ParsedMarkdownMemoryEntry {
  const { text, created, lastReferenced } = parseMetadataComment(rawEntry);
  const parsedProject = normalizeNullable(project);

  if (target !== 'failure') {
    return {
      content: text,
      target,
      project: parsedProject,
      created,
      lastReferenced,
    };
  }

  let category: MemoryCategory | null = null;
  let failureReason: string | null = null;
  let toolState: string | null = null;
  let correctedTo: string | null = null;

  const categoryMatch = text.match(/^\[([^\]]+)\]\s+/);
  if (categoryMatch && FAILURE_CATEGORY_SET.has(categoryMatch[1] as MemoryCategory)) {
    category = categoryMatch[1] as MemoryCategory;
  }

  const segments = text.split(' — ');
  for (const segment of segments.slice(1)) {
    if (segment.startsWith('Failed: ') && !failureReason) {
      failureReason = segment.slice('Failed: '.length).trim() || null;
      continue;
    }
    if (segment.startsWith('Tool state: ') && !toolState) {
      toolState = segment.slice('Tool state: '.length).trim() || null;
      continue;
    }
    if (segment.startsWith('Corrected to: ') && !correctedTo) {
      correctedTo = segment.slice('Corrected to: '.length).trim() || null;
    }
  }

  return {
    content: text,
    target: 'failure',
    project: parsedProject,
    category,
    failureReason,
    toolState,
    correctedTo,
    created,
    lastReferenced,
  };
}

/**
 * Idempotently sync a Markdown-backed memory entry into SQLite.
 * Duplicate identity is exact: project + target + category + content.
 */
export function syncMemoryEntry(
  dbManager: DatabaseManager,
  input: SqliteMemorySyncInput,
): SqliteMemorySyncResult {
  const db = dbManager.getDb();
  const content = input.content.trim();
  const project = normalizeNullable(input.project);
  const category = normalizeCategory(input.category);
  const failureReason = normalizeNullable(input.failureReason);
  const toolState = normalizeNullable(input.toolState);
  const correctedTo = normalizeNullable(input.correctedTo);
  const created = input.created?.trim() || today();
  const lastReferenced = input.lastReferenced?.trim() || created;

  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, input.target, project, category);
  conditions.push('content = ?');
  params.push(content);

  const existing = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY id ASC
    LIMIT 1
  `).get(...params) as {
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  } | undefined;

  if (!existing) {
    return {
      action: 'inserted',
      entry: addMemory(
        dbManager,
        content,
        input.target,
        project,
        category,
        failureReason,
        toolState,
        correctedTo,
        created,
        lastReferenced,
      ),
    };
  }

  const updatedCreated = minDate(existing.created, created);
  const updatedLastReferenced = maxDate(existing.last_referenced, lastReferenced);
  const updatedCategory = (existing.category as MemoryCategory | null) ?? category;
  const updatedFailureReason = existing.failure_reason ?? failureReason;
  const updatedToolState = existing.tool_state ?? toolState;
  const updatedCorrectedTo = existing.corrected_to ?? correctedTo;

  db.prepare(`
    UPDATE memories
    SET category = ?, failure_reason = ?, tool_state = ?, corrected_to = ?, created = ?, last_referenced = ?
    WHERE id = ?
  `).run(
    updatedCategory,
    updatedFailureReason,
    updatedToolState,
    updatedCorrectedTo,
    updatedCreated,
    updatedLastReferenced,
    existing.id,
  );

  return {
    action: 'existing',
    entry: getMemoryById(dbManager, existing.id)!,
  };
}

/**
 * Best-effort substring replacement for SQLite-backed memory sync.
 * Updates all matches in the scoped slice to recover from prior duplicate rows.
 */
export function replaceSyncedMemories(
  dbManager: DatabaseManager,
  oldText: string,
  updates: {
    content: string;
    target: 'memory' | 'user' | 'failure';
    project?: string | null;
    category?: MemoryCategory | null;
    failureReason?: string | null;
    toolState?: string | null;
    correctedTo?: string | null;
    lastReferenced?: string | null;
  },
): SqliteMemoryUpdateResult {
  const db = dbManager.getDb();
  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, updates.target, updates.project ?? undefined);
  conditions.push(`content LIKE ? ESCAPE '\\'`);
  params.push(`%${escapeLikePattern(oldText)}%`);

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY id ASC
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
  }>;

  if (rows.length === 0) {
    return { matched: 0, updated: 0, entries: [] };
  }

  const nextLastReferenced = updates.lastReferenced?.trim() || today();

  for (const row of rows) {
    db.prepare(`
      UPDATE memories
      SET content = ?,
          category = ?,
          failure_reason = ?,
          tool_state = ?,
          corrected_to = ?,
          last_referenced = ?
      WHERE id = ?
    `).run(
      updates.content.trim(),
      updates.category === undefined ? row.category : updates.category,
      updates.failureReason === undefined ? row.failure_reason : normalizeNullable(updates.failureReason),
      updates.toolState === undefined ? row.tool_state : normalizeNullable(updates.toolState),
      updates.correctedTo === undefined ? row.corrected_to : normalizeNullable(updates.correctedTo),
      nextLastReferenced,
      row.id,
    );
  }

  return {
    matched: rows.length,
    updated: rows.length,
    entries: rows
      .map((row) => getMemoryById(dbManager, row.id))
      .filter((entry): entry is SqliteMemoryEntry => entry !== null),
  };
}

/**
 * Best-effort substring removal for SQLite-backed memory sync.
 * Deletes all matches in the scoped slice to recover from prior duplicate rows.
 */
export function removeSyncedMemories(
  dbManager: DatabaseManager,
  oldText: string,
  options: SqliteMemoryRemoveOptions,
): SqliteMemoryRemoveResult {
  const db = dbManager.getDb();
  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
  conditions.push(`content LIKE ? ESCAPE '\\'`);
  params.push(`%${escapeLikePattern(oldText)}%`);

  const matchingIds = db.prepare(`
    SELECT id
    FROM memories
    WHERE ${conditions.join(' AND ')}
  `).all(...params) as Array<{ id: number }>;

  if (matchingIds.length === 0) {
    return { matched: 0, removed: 0 };
  }

  const deleteParams = matchingIds.map((row) => row.id);
  const placeholders = deleteParams.map(() => '?').join(', ');
  const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...deleteParams);

  return {
    matched: matchingIds.length,
    removed: result.changes,
  };
}

/**
 * Exact removal for Markdown entries whose full content is known.
 * Used for FIFO eviction cleanup, where substring matching could remove
 * unrelated SQLite mirror rows that merely contain the evicted text.
 */
export function removeExactSyncedMemories(
  dbManager: DatabaseManager,
  content: string,
  options: SqliteMemoryRemoveOptions,
): SqliteMemoryRemoveResult {
  const db = dbManager.getDb();
  const params: unknown[] = [];
  const conditions = buildScopeConditions(params, options.target, options.project ?? undefined);
  conditions.push('content = ?');
  params.push(content.trim());

  const matchingIds = db.prepare(`
    SELECT id
    FROM memories
    WHERE ${conditions.join(' AND ')}
  `).all(...params) as Array<{ id: number }>;

  if (matchingIds.length === 0) {
    return { matched: 0, removed: 0 };
  }

  const deleteParams = matchingIds.map((row) => row.id);
  const placeholders = deleteParams.map(() => '?').join(', ');
  const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...deleteParams);

  return {
    matched: matchingIds.length,
    removed: result.changes,
  };
}

/**
 * Search memories using FTS5.
 */
type CandidateRow = {
  id: number;
  project: string | null;
  target: string;
  category: string | null;
  content: string;
  failure_reason: string | null;
  tool_state: string | null;
  corrected_to: string | null;
  created: string;
  last_referenced: string;
  reference_count: number;
  hrr_vector: Buffer | null;
  hrr_dim: number | null;
  fts_rank: number | null;
};

export function searchMemories(
  dbManager: DatabaseManager,
  query: string,
  options: {
    project?: string;
    target?: string;
    category?: MemoryCategory;
    limit?: number;
    temporalDecayHalfLifeDays?: number;
    frequencyBoost?: boolean;
    jaccardWeight?: number;
    hrrWeight?: number;
    ftsWeight?: number;
    hrrCandidateCap?: number;
    minScore?: number;
  } = {}
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const {
    project,
    target,
    category,
    limit = 10,
    temporalDecayHalfLifeDays = 0,
    frequencyBoost = false,
    jaccardWeight = 0,
    hrrWeight = 0,
    ftsWeight = 1,
    hrrCandidateCap = 500,
    minScore = 0,
  } = options;

  const filterClauses: string[] = [];
  const filterParams: unknown[] = [];
  if (project !== undefined) {
    if (project === null) {
      filterClauses.push('m.project IS NULL');
    } else {
      filterClauses.push('m.project = ?');
      filterParams.push(project);
    }
  }
  if (target) {
    filterClauses.push('m.target = ?');
    filterParams.push(target);
  }
  if (category) {
    filterClauses.push('m.category = ?');
    filterParams.push(category);
  }

  const reranking = temporalDecayHalfLifeDays > 0 || frequencyBoost || jaccardWeight > 0 || hrrWeight > 0;
  const candidateLimit = reranking ? limit * 3 : limit;

  // Stage 1: FTS5 candidates (implicit AND across query terms).
  const ftsConditions = ['memory_fts MATCH ?', ...filterClauses];
  const ftsParams: unknown[] = [escapeFts5Query(query), ...filterParams];
  const ftsSql = `
    SELECT m.id, m.project, m.target, m.category, m.content, m.failure_reason, m.tool_state, m.corrected_to, m.created, m.last_referenced, m.reference_count, m.hrr_vector, m.hrr_dim, memory_fts.rank AS fts_rank
    FROM memory_fts
    JOIN memories m ON m.id = memory_fts.rowid
    WHERE ${ftsConditions.join(' AND ')}
    ORDER BY memory_fts.rank
    LIMIT ?
  `;
  ftsParams.push(candidateLimit);
  const ftsRows = db.prepare(ftsSql).all(...ftsParams) as CandidateRow[];

  // Stage 2 (HRR only): pull additional candidates that may have zero FTS overlap.
  // This is the key bypass for FTS5's implicit-AND blind spot on long queries.
  let extraRows: CandidateRow[] = [];
  if (hrrWeight > 0) {
    const seen = new Set(ftsRows.map((r) => r.id));
    const where = filterClauses.length > 0 ? `WHERE m.hrr_vector IS NOT NULL AND ${filterClauses.join(' AND ')}` : 'WHERE m.hrr_vector IS NOT NULL';
    const hrrSql = `
      SELECT m.id, m.project, m.target, m.category, m.content, m.failure_reason, m.tool_state, m.corrected_to, m.created, m.last_referenced, m.reference_count, m.hrr_vector, m.hrr_dim, NULL AS fts_rank
      FROM memories m
      ${where}
      ORDER BY m.id DESC
      LIMIT ?
    `;
    const all = db.prepare(hrrSql).all(...filterParams, hrrCandidateCap) as CandidateRow[];
    extraRows = all.filter((r) => !seen.has(r.id));
  }

  const rows = [...ftsRows, ...extraRows];
  if (rows.length === 0) return [];

  if (!reranking) {
    return rows.map(mapRow);
  }

  // BM25 rank from FTS5 is negative (lower = better). Normalise to [0,1] across FTS hits only.
  const ftsRanks = ftsRows.map((r) => Math.abs(r.fts_rank ?? 0));
  const maxRank = Math.max(...ftsRanks, 1e-6);

  // Frequency boost: log(1 + accesses/day) normalised by the max in the candidate set.
  const now = Date.now();
  const rawFreqs = rows.map((r) => {
    const ageDays = Math.max(1, (now - Date.parse(r.created)) / 86_400_000);
    return Math.log1p(r.reference_count / ageDays);
  });
  const maxFreq = Math.max(...rawFreqs, 1e-6);

  // Precompute query tokens + HRR vector once.
  const queryTokens = (jaccardWeight > 0) ? tokenizeForJaccard(query) : null;
  const hrrDimUsed = rows.find((r) => r.hrr_dim)?.hrr_dim ?? DEFAULT_HRR_DIM;
  const queryHrr = (hrrWeight > 0) ? encodeText(query, hrrDimUsed) : null;

  const totalWeight = Math.max(ftsWeight + jaccardWeight + hrrWeight, 1e-9);

  return rows
    .map((r, i) => {
      const entry = mapRow(r);
      const normFts = r.fts_rank != null ? Math.abs(r.fts_rank) / maxRank : 0;
      let jacc = 0;
      if (queryTokens) {
        jacc = jaccard(queryTokens, tokenizeForJaccard(r.content));
      }
      let hrrSim = 0;
      if (queryHrr && r.hrr_vector && r.hrr_dim === queryHrr.length) {
        const v = bytesToPhases(r.hrr_vector);
        hrrSim = (hrrSimilarity(queryHrr, v) + 1) / 2; // shift [-1,1] → [0,1]
      }
      const relevance = (ftsWeight * normFts + jaccardWeight * jacc + hrrWeight * hrrSim) / totalWeight;
      const decay = temporalDecay(entry.lastReferenced, temporalDecayHalfLifeDays);
      const freq = frequencyBoost ? rawFreqs[i] / maxFreq : 1.0;
      return { entry, score: relevance * decay * freq, relevance };
    })
    .filter((s) => s.relevance >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/**
 * Backfill HRR vectors for any memory rows that don't have one yet (or that
 * were encoded at a different dimension). Returns the number of rows updated.
 * Safe to call repeatedly — it is idempotent for entries already at hrrDim.
 */
export function backfillHrrVectors(
  dbManager: DatabaseManager,
  hrrDim: number = DEFAULT_HRR_DIM,
  onProgress?: (processed: number, total: number) => void,
): number {
  const db = dbManager.getDb();
  const rows = db.prepare(
    'SELECT id, content FROM memories WHERE hrr_vector IS NULL OR hrr_dim IS NULL OR hrr_dim != ?'
  ).all(hrrDim) as Array<{ id: number; content: string }>;
  if (rows.length === 0) return 0;
  const update = db.prepare('UPDATE memories SET hrr_vector = ?, hrr_dim = ? WHERE id = ?');
  let n = 0;
  let processed = 0;
  for (const row of rows) {
    try {
      const vec = phasesToBytes(encodeText(row.content, hrrDim));
      update.run(vec, hrrDim, row.id);
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
 * Get all memories, optionally filtered.
 */
export function getMemories(
  dbManager: DatabaseManager,
  options: { project?: string | null; target?: string; category?: MemoryCategory } = {}
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const { project, target, category } = options;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('project = ?');
      params.push(project);
    }
  }

  if (target) {
    conditions.push('target = ?');
    params.push(target);
  }

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    ${whereClause}
    ORDER BY last_referenced DESC
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
    reference_count: number;
  }>;

  return rows.map(mapRow);
}

/**
 * Remove a memory by ID.
 */
export function removeMemory(dbManager: DatabaseManager, id: number): boolean {
  const db = dbManager.getDb();
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get recent failure memories (last N days).
 */
export function getRecentFailures(
  dbManager: DatabaseManager,
  maxAgeDays = 7,
  project?: string | null
): SqliteMemoryEntry[] {
  const db = dbManager.getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const conditions: string[] = ['target = ?', 'created >= ?'];
  const params: unknown[] = ['failure', cutoffStr];

  if (project !== undefined) {
    if (project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('(project = ? OR project IS NULL)');
      params.push(project);
    }
  }

  const rows = db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY created DESC
    LIMIT 5
  `).all(...params) as Array<{
    id: number;
    project: string | null;
    target: string;
    category: string | null;
    content: string;
    failure_reason: string | null;
    tool_state: string | null;
    corrected_to: string | null;
    created: string;
    last_referenced: string;
    reference_count: number;
  }>;

  return rows.map(mapRow);
}

/**
 * Update a memory's last_referenced date.
 */
export function touchMemory(dbManager: DatabaseManager, id: number): void {
  const db = dbManager.getDb();
  db.prepare('UPDATE memories SET last_referenced = ?, reference_count = reference_count + 1 WHERE id = ?').run(today(), id);
}

/**
 * Get memory statistics.
 */
export function getMemoryStats(dbManager: DatabaseManager): {
  total: number;
  byProject: { project: string | null; count: number }[];
  byTarget: { target: string; count: number }[];
} {
  const db = dbManager.getDb();

  const total = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;

  const byProject = db.prepare(`
    SELECT project, COUNT(*) as count
    FROM memories
    GROUP BY project
    ORDER BY count DESC
  `).all() as { project: string | null; count: number }[];

  const byTarget = db.prepare(`
    SELECT target, COUNT(*) as count
    FROM memories
    GROUP BY target
    ORDER BY count DESC
  `).all() as { target: string; count: number }[];

  return { total, byProject, byTarget };
}
