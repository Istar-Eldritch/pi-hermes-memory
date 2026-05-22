import * as path from 'node:path';
import * as os from 'node:os';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { DatabaseManager } from '../store/db.js';
import { mineEvalPairs } from '../calibration/mine.js';
import { judgeEvalPairs } from '../calibration/judge.js';
import { gridSearch } from '../calibration/tune.js';
import { saveSearchConfig, type LiveSearchConfig } from '../calibration/search-config.js';

export function registerRecalibrateCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  memoryDir: string,
  liveConfig: LiveSearchConfig,
): void {
  pi.registerCommand('memory-recalibrate', {
    description: 'Re-mine eval pairs, judge relevance via a pi subprocess, tune search weights, and apply the best config live',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const notify = (msg: string) => ctx.ui.notify(msg, 'info');
      const notifyErr = (msg: string) => ctx.ui.notify(msg, 'error');

      try {
        // Step 1: Mine
        notify('🔍 Mining eval pairs from session history…');
        const { pairs, memoriesScanned, memoriesWithCandidates, memoriesSkippedNoProject } = mineEvalPairs(dbManager);

        if (pairs.length === 0) {
          notify('⚠️  No eval pairs could be mined — need more project-scoped memories with nearby session messages.');
          return;
        }
        notify(`📋 Mined ${pairs.length} pairs from ${memoriesWithCandidates}/${memoriesScanned} memories (${memoriesSkippedNoProject} had no project scope).`);

        // Step 2: Judge via pi subprocess
        notify('🧠 Spawning pi judge — this may take a few minutes…');
        const judgingDir = path.join(memoryDir, 'calibration');
        let judgeLines = 0;
        const judged = await judgeEvalPairs(pairs, memoryDir, judgingDir, (line) => {
          judgeLines++;
          // Surface occasional stderr lines as progress without spamming.
          if (judgeLines % 20 === 1) notify(`🧠 Judging… (${line.slice(0, 80)})`);
        });

        if (judged.length === 0) {
          notify('⚠️  Judge returned no relevant pairs — eval set may be too sparse.');
          return;
        }
        const score2 = judged.filter((p) => p.relevance === 2).length;
        notify(`✅ Judge complete: ${judged.length} relevant pairs (${score2} clearly relevant, ${judged.length - score2} marginal).`);

        // Step 3: Grid search
        notify('⚙️  Running grid search…');
        let lastNotify = Date.now();
        const results = gridSearch(dbManager, judged, (done, total, bestNdcg) => {
          const now = Date.now();
          if (now - lastNotify >= 2000) {
            lastNotify = now;
            notify(`⚙️  Grid search: ${done}/${total} configs — best nDCG@5 so far: ${bestNdcg.toFixed(3)}`);
          }
        });

        const best = results[0];
        if (!best) {
          notifyErr('Grid search returned no results.');
          return;
        }

        // Step 4: Apply
        liveConfig.current = best.config;
        saveSearchConfig(memoryDir, best.config);

        const cfg = best.config;
        let output = `\n✅ Recalibration complete!\n\n`;
        output += `📊 Best config (nDCG@5=${best.ndcg.toFixed(3)}, Hit@5=${best.hitAtK.toFixed(3)}, MRR=${best.mrr.toFixed(3)}):\n`;
        output += `├─ ftsWeight:                ${cfg.ftsWeight}\n`;
        output += `├─ jaccardWeight:            ${cfg.jaccardWeight}\n`;
        output += `├─ hrrWeight:                ${cfg.hrrWeight}\n`;
        output += `├─ minScore:                 ${cfg.minScore}\n`;
        output += `└─ temporalDecayHalfLifeDays: ${cfg.temporalDecayHalfLifeDays}\n`;
        output += `\n💾 Config saved to ${path.join(memoryDir, 'search-config.json')} and applied live.`;
        notify(output);
      } catch (err) {
        notifyErr(`❌ Recalibration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
