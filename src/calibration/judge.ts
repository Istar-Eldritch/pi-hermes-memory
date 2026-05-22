import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPiTask } from './pi-runner.js';
import type { MinedPair } from './mine.js';

export interface JudgedPair extends MinedPair {
  relevance: 0 | 1 | 2;
  judgeReason: string;
}

function buildJudgePrompt(minedFile: string, judgedFile: string, memoryDir: string): string {
  return `You are a relevance judge for a memory search evaluation set.

Read the mined pairs from \`${minedFile}\`. Each line is JSON with fields: query, goldMemoryId, project, memoryDate, messageTimestamp, source.

To look up memory content run:
\`\`\`bash
cd ${path.resolve(path.join(memoryDir, '..', '..', 'pi-hermes-memory'))} && npx tsx -e "
import { DatabaseManager } from './src/store/db.js';
const db = new DatabaseManager('${memoryDir}').getDb();
const rows = db.prepare('SELECT id, project, target, content FROM memories ORDER BY id').all();
for (const r of rows) console.log(JSON.stringify(r));
" 2>/dev/null
\`\`\`

For each pair judge whether the memory is genuinely relevant to the query — i.e. would retrieving this memory actually help answer or contextualise the query?

Scores:
- 2 = clearly relevant (memory directly addresses the query topic)
- 1 = marginally relevant (some topical overlap but indirect)
- 0 = irrelevant (same-session coincidence, no meaningful connection)

Write output to \`${judgedFile}\` as JSONL: each line is the original JSON object with two extra fields added: \`relevance\` (0/1/2) and \`judgeReason\` (one short sentence).

Only include pairs with relevance >= 1 in the output file.

Process all pairs. When done, print a single line: JUDGE_DONE:<count> where count is the number of pairs written.`;
}

export async function judgeEvalPairs(
  pairs: MinedPair[],
  memoryDir: string,
  judgingDir: string,
  onProgress?: (line: string) => void,
): Promise<JudgedPair[]> {
  fs.mkdirSync(judgingDir, { recursive: true });
  const minedFile = path.join(judgingDir, 'eval-mined.jsonl');
  const judgedFile = path.join(judgingDir, 'eval-judged.jsonl');

  // Write mined pairs for the subprocess to read.
  fs.writeFileSync(minedFile, pairs.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf-8');

  // Remove stale judged file so we don't read old results on failure.
  try { fs.rmSync(judgedFile); } catch { /* ok */ }

  const task = buildJudgePrompt(minedFile, judgedFile, memoryDir);
  await runPiTask(task, {
    tools: ['read', 'write', 'bash'],
    onStderr: onProgress,
  });

  if (!fs.existsSync(judgedFile)) {
    throw new Error('Judge subprocess did not produce eval-judged.jsonl');
  }

  const raw = fs.readFileSync(judgedFile, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map((l) => JSON.parse(l) as JudgedPair);
}
