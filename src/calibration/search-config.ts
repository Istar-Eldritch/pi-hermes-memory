import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SearchConfig } from './tune.js';

const CONFIG_FILE = 'search-config.json';

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  ftsWeight: 0.15,
  jaccardWeight: 0.3,
  hrrWeight: 0.8,
  minScore: 0.3,
  temporalDecayHalfLifeDays: 60,
};

export function loadSearchConfig(memoryDir: string): SearchConfig {
  const p = path.join(memoryDir, CONFIG_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<SearchConfig>;
    return { ...DEFAULT_SEARCH_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_SEARCH_CONFIG };
  }
}

export function saveSearchConfig(memoryDir: string, config: SearchConfig): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Mutable live config — shared between auto-retrieval and recalibrate handler. */
export interface LiveSearchConfig {
  current: SearchConfig;
}

export function createLiveConfig(memoryDir: string): LiveSearchConfig {
  return { current: loadSearchConfig(memoryDir) };
}
