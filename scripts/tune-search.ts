/**
 * Grid-search memory search parameters against a mined eval set.
 *
 * Reads `fixtures/eval-mined.jsonl` (or the path given on argv[2]) and runs
 * `searchMemories` for each (query, goldMemoryId) across a configurable
 * grid, then prints the top-N configurations by nDCG@5.
 *
 * Metrics reported per config:
 *   Hit@K   — fraction of queries where gold appears in top-K
 *   MRR     — mean reciprocal rank of gold (0 if not in top-K)
 *   nDCG@K  — discounted cumulative gain, binary relevance, K=5
 *
 * Usage:
 *   npx tsx scripts/tune-search.ts [evalFile] [memoryDir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseManager } from '../src/store/db.js';
import { searchMemories, type SqliteMemoryEntry } from '../src/store/sqlite-memory-store.js';

interface EvalPair {
  query: string;
  goldMemoryId: number;
  project?: string | null;
}

interface Config {
  ftsWeight: number;
  jaccardWeight: number;
  hrrWeight: number;
  minScore: number;
  temporalDecayHalfLifeDays: number;
}

const K = 5;
const SEARCH_LIMIT = 10; // need >K to give MRR a fair shot

function loadEval(file: string): EvalPair[] {
  const raw = fs.readFileSync(file, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map((l) => JSON.parse(l) as EvalPair);
}

function rankOfGold(results: SqliteMemoryEntry[], goldId: number): number {
  for (let i = 0; i < results.length; i++) {
    if (results[i].id === goldId) return i + 1;
  }
  return -1;
}

function ndcgAtK(rank: number, k: number): number {
  if (rank < 1 || rank > k) return 0;
  // Binary relevance: gain=1 at gold, 0 elsewhere. IDCG=1 at rank 1.
  return 1 / Math.log2(rank + 1);
}

function evaluateConfig(
  dbManager: DatabaseManager,
  pairs: EvalPair[],
  cfg: Config,
): { hitAtK: number; mrr: number; ndcg: number; n: number } {
  let hits = 0;
  let rrSum = 0;
  let ndcgSum = 0;

  for (const p of pairs) {
    const results = searchMemories(dbManager, p.query, {
      limit: SEARCH_LIMIT,
      ftsWeight: cfg.ftsWeight,
      jaccardWeight: cfg.jaccardWeight,
      hrrWeight: cfg.hrrWeight,
      minScore: cfg.minScore,
      temporalDecayHalfLifeDays: cfg.temporalDecayHalfLifeDays,
    });
    const rank = rankOfGold(results, p.goldMemoryId);
    if (rank > 0 && rank <= K) hits++;
    rrSum += rank > 0 ? 1 / rank : 0;
    ndcgSum += ndcgAtK(rank, K);
  }

  return {
    hitAtK: hits / pairs.length,
    mrr: rrSum / pairs.length,
    ndcg: ndcgSum / pairs.length,
    n: pairs.length,
  };
}

function gridSearch(dbManager: DatabaseManager, pairs: EvalPair[]) {
  // Coarse grid (~108 configs). Refine around the winner in a follow-up run.
  const ftsWeights = [0.15, 0.3, 0.5];
  const jaccardWeights = [0.15, 0.3];
  const hrrWeights = [0.3, 0.55, 0.8];
  const minScores = [0.3, 0.45, 0.6];
  const halfLives = [0, 60];

  const results: Array<{ cfg: Config; metrics: ReturnType<typeof evaluateConfig> }> = [];
  const total = ftsWeights.length * jaccardWeights.length * hrrWeights.length * minScores.length * halfLives.length;
  console.error(`Grid size: ${total} configs × ${pairs.length} queries = ${total * pairs.length} searches`);
  let i = 0;
  let bestNdcg = 0;
  const tStart = Date.now();

  for (const ftsWeight of ftsWeights) {
    for (const jaccardWeight of jaccardWeights) {
      for (const hrrWeight of hrrWeights) {
        for (const minScore of minScores) {
          for (const temporalDecayHalfLifeDays of halfLives) {
            i++;
            const cfg: Config = { ftsWeight, jaccardWeight, hrrWeight, minScore, temporalDecayHalfLifeDays };
            const metrics = evaluateConfig(dbManager, pairs, cfg);
            results.push({ cfg, metrics });
            const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
            process.stderr.write(`\r${i}/${total} configs (${elapsed}s)  best nDCG so far: ${bestNdcg.toFixed(3)}`);
            if (metrics.ndcg > bestNdcg) bestNdcg = metrics.ndcg;
          }
        }
      }
    }
  }
  process.stderr.write('\n');
  return results;
}

function fmtCfg(cfg: Config): string {
  return [
    `fts=${cfg.ftsWeight.toFixed(2)}`,
    `jac=${cfg.jaccardWeight.toFixed(2)}`,
    `hrr=${cfg.hrrWeight.toFixed(2)}`,
    `min=${cfg.minScore.toFixed(2)}`,
    `hl=${cfg.temporalDecayHalfLifeDays}`,
  ].join(' ');
}

function main(): void {
  const evalFile = process.argv[2] ?? path.join(process.cwd(), 'fixtures', 'eval-mined.jsonl');
  const memoryDir = process.argv[3] ?? path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory');

  const pairs = loadEval(evalFile);
  if (pairs.length === 0) {
    console.error(`No eval pairs in ${evalFile}`);
    process.exit(1);
  }
  console.log(`Loaded ${pairs.length} eval pairs from ${evalFile}`);
  console.log(`DB: ${memoryDir}\n`);

  const dbManager = new DatabaseManager(memoryDir);

  // Baseline = current production defaults from setupAutoRetrieval.
  const baseline: Config = {
    ftsWeight: 0.15,
    jaccardWeight: 0.25,
    hrrWeight: 0.6,
    minScore: 0.55,
    temporalDecayHalfLifeDays: 0,
  };
  const baseMetrics = evaluateConfig(dbManager, pairs, baseline);
  console.log(`Baseline (current defaults):  ${fmtCfg(baseline)}`);
  console.log(`  Hit@${K}=${baseMetrics.hitAtK.toFixed(3)}  MRR=${baseMetrics.mrr.toFixed(3)}  nDCG@${K}=${baseMetrics.ndcg.toFixed(3)}\n`);

  console.log('Running grid search...');
  const results = gridSearch(dbManager, pairs);

  results.sort((a, b) => b.metrics.ndcg - a.metrics.ndcg);
  console.log(`\nTop 10 configs by nDCG@${K}:`);
  console.log('  rank   nDCG    MRR    Hit@K  config');
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const { cfg, metrics } = results[i];
    console.log(
      `  ${String(i + 1).padStart(4)}   ${metrics.ndcg.toFixed(3)}  ${metrics.mrr.toFixed(3)}  ${metrics.hitAtK.toFixed(3)}  ${fmtCfg(cfg)}`,
    );
  }

  dbManager.close();
}

main();
