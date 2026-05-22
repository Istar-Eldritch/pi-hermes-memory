import { DatabaseManager } from '../store/db.js';
import { searchMemories } from '../store/sqlite-memory-store.js';

export interface EvalPair {
  query: string;
  goldMemoryId: number;
  relevance?: number;
}

export interface SearchConfig {
  ftsWeight: number;
  jaccardWeight: number;
  hrrWeight: number;
  minScore: number;
  temporalDecayHalfLifeDays: number;
}

export interface ConfigResult {
  config: SearchConfig;
  hitAtK: number;
  mrr: number;
  ndcg: number;
}

const K = 5;
const SEARCH_LIMIT = 10;

function ndcgAtK(rank: number, k: number): number {
  if (rank < 1 || rank > k) return 0;
  return 1 / Math.log2(rank + 1);
}

function evaluateConfig(
  dbManager: DatabaseManager,
  pairs: EvalPair[],
  cfg: SearchConfig,
): { hitAtK: number; mrr: number; ndcg: number } {
  let hits = 0, rrSum = 0, ndcgSum = 0;
  for (const p of pairs) {
    const results = searchMemories(dbManager, p.query, {
      limit: SEARCH_LIMIT,
      ftsWeight: cfg.ftsWeight,
      jaccardWeight: cfg.jaccardWeight,
      hrrWeight: cfg.hrrWeight,
      minScore: cfg.minScore,
      temporalDecayHalfLifeDays: cfg.temporalDecayHalfLifeDays,
    });
    const rank = results.findIndex((r) => r.id === p.goldMemoryId) + 1;
    if (rank > 0 && rank <= K) hits++;
    rrSum += rank > 0 ? 1 / rank : 0;
    ndcgSum += ndcgAtK(rank, K);
  }
  return { hitAtK: hits / pairs.length, mrr: rrSum / pairs.length, ndcg: ndcgSum / pairs.length };
}

export function gridSearch(
  dbManager: DatabaseManager,
  pairs: EvalPair[],
  onProgress?: (done: number, total: number, bestNdcg: number) => void,
): ConfigResult[] {
  const ftsWeights    = [0.15, 0.3, 0.5];
  const jaccardWeights = [0.15, 0.3];
  const hrrWeights    = [0.3, 0.55, 0.8];
  const minScores     = [0.3, 0.45, 0.6];
  const halfLives     = [0, 60];

  const total = ftsWeights.length * jaccardWeights.length * hrrWeights.length * minScores.length * halfLives.length;
  const results: ConfigResult[] = [];
  let done = 0, bestNdcg = 0;

  for (const ftsWeight of ftsWeights)
    for (const jaccardWeight of jaccardWeights)
      for (const hrrWeight of hrrWeights)
        for (const minScore of minScores)
          for (const temporalDecayHalfLifeDays of halfLives) {
            const config: SearchConfig = { ftsWeight, jaccardWeight, hrrWeight, minScore, temporalDecayHalfLifeDays };
            const metrics = evaluateConfig(dbManager, pairs, config);
            results.push({ config, ...metrics });
            done++;
            if (metrics.ndcg > bestNdcg) bestNdcg = metrics.ndcg;
            onProgress?.(done, total, bestNdcg);
          }

  return results.sort((a, b) => b.ndcg - a.ndcg);
}
