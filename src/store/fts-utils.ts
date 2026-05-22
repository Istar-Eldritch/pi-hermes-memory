/**
 * Shared FTS5 query helpers and reranking primitives.
 *
 * Used by both memory search and session search so the two stay aligned on:
 *  - multi-word query handling (implicit AND across quoted terms),
 *  - temporal decay scoring,
 *  - Jaccard token-overlap reranking.
 */

/**
 * Escape a query for FTS5 `MATCH`.
 *
 * Wrapping the entire query in double quotes turns it into an exact phrase
 * search, which almost never matches free-form natural language. Instead we
 * quote each term individually and rely on FTS5's implicit-AND semantics so
 * all terms must appear, in any order.
 *
 * Pass-through: if the query already contains explicit FTS5 operators
 * (OR, AND, NOT, NEAR), it is returned unchanged so callers can opt into
 * advanced syntax.
 */
export function escapeFts5Query(query: string): string {
  if (/\b(OR|AND|NOT|NEAR)\b/.test(query)) {
    return query;
  }
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * Exponential half-life decay in days. Returns 1.0 when halfLifeDays<=0 or
 * the timestamp is in the future, so callers can leave the multiplier in
 * place unconditionally.
 */
export function temporalDecay(dateStr: string, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1.0;
  const ageDays = (Date.now() - Date.parse(dateStr)) / 86_400_000;
  if (ageDays < 0) return 1.0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Lowercase + strip surrounding punctuation token set for Jaccard overlap. */
export function tokenizeForJaccard(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/\s+/)) {
    const cleaned = w.replace(/^[.,!?;:"'()\[\]{}<>#@]+|[.,!?;:"'()\[\]{}<>#@]+$/g, '');
    if (cleaned) out.add(cleaned);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
