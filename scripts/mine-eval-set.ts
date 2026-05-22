/**
 * Mine an evaluation set for memory search from organically captured data.
 *
 * Heuristic: a memory is saved in the middle of a conversation about its
 * topic, so user messages from the same project on the same day (and the
 * preceding day) are de facto relevant queries for that memory.
 *
 * Output: JSONL with one object per (query, goldMemoryId) pair.
 *
 * Usage:
 *   npx tsx scripts/mine-eval-set.ts [memoryDir] [outFile]
 *   npx tsx scripts/mine-eval-set.ts ~/.pi/agent/pi-hermes-memory fixtures/eval-mined.jsonl
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseManager } from '../src/store/db.js';
import { extractContentTerms } from '../src/utils/stopwords.js';

const MIN_QUERY_TERMS = 3;
const MAX_QUERIES_PER_MEMORY = 4;
const LOOKBACK_DAYS = 1;
const MIN_QUERY_CHARS = 20;
const MAX_QUERY_CHARS = 400;

interface MinedPair {
  query: string;
  goldMemoryId: number;
  project: string | null;
  memoryDate: string;
  messageTimestamp: string;
  source: 'memory_creation_context';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '\u2026';
}

function dayBoundsIso(dateStr: string, lookbackDays: number): { from: string; to: string } | null {
  // Accept either 'YYYY-MM-DD' or full ISO. Normalise to a YYYY-MM-DD prefix.
  const dayMatch = dateStr.match(/^\d{4}-\d{2}-\d{2}/);
  if (!dayMatch) return null;
  const day = dayMatch[0];
  const end = new Date(`${day}T23:59:59.999Z`);
  if (Number.isNaN(end.getTime())) return null;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  start.setUTCHours(0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

function mine(memoryDir: string, outFile: string): void {
  const dbManager = new DatabaseManager(memoryDir);
  const db = dbManager.getDb();

  const memories = db.prepare(`
    SELECT id, project, content, created
    FROM memories
    WHERE created IS NOT NULL
  `).all() as Array<{ id: number; project: string | null; content: string; created: string }>;

  const findMessages = db.prepare(`
    SELECT m.content AS content, m.timestamp AS timestamp
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.role = 'user'
      AND s.project = ?
      AND m.timestamp >= ?
      AND m.timestamp <= ?
    ORDER BY m.timestamp DESC
  `);

  const pairs: MinedPair[] = [];
  let memoriesWithCandidates = 0;
  let memoriesSkippedNoProject = 0;
  let memoriesSkippedNoMessages = 0;

  for (const mem of memories) {
    if (!mem.project) {
      memoriesSkippedNoProject++;
      continue;
    }
    const bounds = dayBoundsIso(mem.created, LOOKBACK_DAYS);
    if (!bounds) {
      memoriesSkippedNoMessages++;
      continue;
    }
    const msgs = findMessages.all(mem.project, bounds.from, bounds.to) as Array<{ content: string; timestamp: string }>;

    const candidates = msgs.filter((m) => {
      const txt = (m.content ?? '').trim();
      if (txt.length < MIN_QUERY_CHARS) return false;
      const terms = extractContentTerms(txt);
      return terms.length >= MIN_QUERY_TERMS;
    });

    if (candidates.length === 0) {
      memoriesSkippedNoMessages++;
      continue;
    }
    memoriesWithCandidates++;

    for (const c of candidates.slice(0, MAX_QUERIES_PER_MEMORY)) {
      pairs.push({
        query: truncate(c.content.trim().replace(/\s+/g, ' '), MAX_QUERY_CHARS),
        goldMemoryId: mem.id,
        project: mem.project,
        memoryDate: mem.created,
        messageTimestamp: c.timestamp,
        source: 'memory_creation_context',
      });
    }
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const lines = pairs.map((p) => JSON.stringify(p));
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf-8');

  console.log(`Mined ${pairs.length} (query, goldMemoryId) pairs.`);
  console.log(`  memories scanned:           ${memories.length}`);
  console.log(`  memories with candidates:   ${memoriesWithCandidates}`);
  console.log(`  skipped (no project):       ${memoriesSkippedNoProject}`);
  console.log(`  skipped (no nearby msgs):   ${memoriesSkippedNoMessages}`);
  console.log(`Wrote ${outFile}`);

  dbManager.close();
}

const memoryDir = process.argv[2] ?? path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory');
const outFile = process.argv[3] ?? path.join(process.cwd(), 'fixtures', 'eval-mined.jsonl');
mine(memoryDir, outFile);
