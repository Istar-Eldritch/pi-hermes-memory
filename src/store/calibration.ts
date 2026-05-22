import path from 'node:path';
import fs from 'node:fs';

export interface CalibrationParams {
  ftsWeight: number;
  jaccardWeight: number;
  hrrWeight: number;
  minScore: number;
  temporalDecayHalfLifeDays: number;
  frequencyBoost: boolean;
  calibratedAt: string;
  evalPairs: number;
  ndcg: number;
}

const FILENAME = 'search-calibration.json';

export function loadCalibration(dbDir: string): Partial<CalibrationParams> {
  const p = path.join(dbDir, FILENAME);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CalibrationParams;
  } catch {
    return {};
  }
}

export function saveCalibration(dbDir: string, params: CalibrationParams): void {
  const p = path.join(dbDir, FILENAME);
  fs.writeFileSync(p, JSON.stringify(params, null, 2), 'utf8');
}
