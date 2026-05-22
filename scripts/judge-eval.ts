#!/usr/bin/env npx tsx
/**
 * Judge mined eval pairs with an LLM.
 *
 * Reads:  fixtures/eval-mined.jsonl  (or --input path)
 * Writes: fixtures/eval-judged.jsonl (or --output path)
 *
 * Usage:
 *   npx tsx scripts/judge-eval.ts
 *   npx tsx scripts/judge-eval.ts --input fixtures/eval-mined.jsonl --output fixtures/eval-judged.jsonl
 *
 * Requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY env var.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : def;
};
const INPUT  = flag('--input',  path.join(ROOT, 'fixtures', 'eval-mined.jsonl'));
const OUTPUT = flag('--output', path.join(ROOT, 'fixtures', 'eval-judged.jsonl'));
const CONCURRENCY = parseInt(flag('--concurrency', '8'), 10);

// ── LLM client ──────────────────────────────────────────────────────────────

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

if (!ANTHROPIC_KEY && !OPENROUTER_KEY) {
  console.error('Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY');
  process.exit(1);
}

interface ChatMessage { role: 'user' | 'assistant'; content: string }

async function chat(messages: ChatMessage[]): Promise<string> {
  if (ANTHROPIC_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 64, messages }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const j = await res.json() as { content: Array<{ text: string }> };
    return j.content[0]?.text ?? '';
  } else {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${OPENROUTER_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'anthropic/claude-haiku-4-5', max_tokens: 64, messages }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const j = await res.json() as { choices: Array<{ message: { content: string } }> };
    return j.choices[0]?.message?.content ?? '';
  }
}

// ── Eval pair type ───────────────────────────────────────────────────────────

interface MinedPair {
  query: string;
  goldMemoryId: number;
  project: string | null;
  memoryDate: string;
  messageTimestamp: string;
  source: string;
}

interface JudgedPair extends MinedPair {
  relevance: number;
  judgeReason: string;
}

// ── Load memory content for context ─────────────────────────────────────────

import { DatabaseManager } from '../src/store/db.js';
import * as os from 'node:os';

const DB_PATH = path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory');
const dbManager = new DatabaseManager(DB_PATH);
const db = dbManager.getDb();

const memoryMap = new Map<number, string>();
for (const row of db.prepare('SELECT id, content FROM memories').all() as Array<{ id: number; content: string }>) {
  memoryMap.set(row.id, row.content);
}

// ── Judge a single pair ──────────────────────────────────────────────────────

async function judgePair(pair: MinedPair): Promise<JudgedPair> {
  const memContent = memoryMap.get(pair.goldMemoryId) ?? '(not found)';
  const prompt = `You are evaluating whether a stored memory entry is relevant to a user query.

Query: "${pair.query}"

Memory: "${memContent}"

Rate the relevance on a 0-2 scale:
  0 = not relevant (different topic, no useful context)
  1 = marginally relevant (related domain, but not directly useful)
  2 = clearly relevant (would genuinely help answer or contextualise the query)

Reply with exactly: <score>|<one-sentence reason>
Example: 2|Memory directly describes the authentication pattern mentioned in the query.`;

  const text = (await chat([{ role: 'user', content: prompt }])).trim();
  const match = text.match(/^([012])\|(.+)/);
  const relevance = match ? parseInt(match[1], 10) : 1;
  const judgeReason = match ? match[2].trim() : text.slice(0, 120);

  return { ...pair, relevance, judgeReason };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const pairs = fs.readFileSync(INPUT, 'utf8')
  .split('\n').filter(Boolean)
  .map((l) => JSON.parse(l) as MinedPair);

console.log(`Judging ${pairs.length} pairs (concurrency=${CONCURRENCY})...`);

// Resume support: skip already-judged
const existing = new Map<string, JudgedPair>();
if (fs.existsSync(OUTPUT)) {
  for (const line of fs.readFileSync(OUTPUT, 'utf8').split('\n').filter(Boolean)) {
    const j = JSON.parse(line) as JudgedPair;
    existing.set(`${j.query}|${j.goldMemoryId}`, j);
  }
  console.log(`Resuming — ${existing.size} already judged.`);
}

const todo = pairs.filter((p) => !existing.has(`${p.query}|${p.goldMemoryId}`));
const judged: JudgedPair[] = [...existing.values()];
let done = 0;
let errors = 0;

const rl = readline.createInterface({ output: process.stdout });

async function runBatch(batch: MinedPair[]): Promise<void> {
  const results = await Promise.allSettled(batch.map(judgePair));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      judged.push(r.value);
    } else {
      errors++;
      console.error('Judge error:', r.reason);
    }
    done++;
    process.stdout.write(`\r${done}/${todo.length} judged (${errors} errors)   `);
  }
}

for (let i = 0; i < todo.length; i += CONCURRENCY) {
  await runBatch(todo.slice(i, i + CONCURRENCY));
}

process.stdout.write('\n');

const outLines = judged.map((j) => JSON.stringify(j)).join('\n') + '\n';
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, outLines, 'utf8');

const dist: Record<number, number> = {};
for (const j of judged) dist[j.relevance] = (dist[j.relevance] ?? 0) + 1;
console.log(`\nWrote ${judged.length} pairs to ${OUTPUT}`);
console.log('Relevance distribution:', dist);
console.log('\nNext: npx tsx scripts/tune-search.ts --judged');
