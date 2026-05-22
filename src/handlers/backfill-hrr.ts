/**
 * /memory-backfill-hrr — populate HRR phase vectors for any memory rows
 * that don't have one yet (or that were encoded at a different dimension).
 *
 * Useful after upgrading from a pre-HRR version, or after changing the
 * default HRR dimension.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DatabaseManager } from "../store/db.js";
import { backfillHrrVectors } from "../store/sqlite-memory-store.js";
import { DEFAULT_HRR_DIM } from "../store/hrr.js";

export function registerBackfillHrrCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  hrrDim: number = DEFAULT_HRR_DIM,
): void {
  pi.registerCommand("memory-backfill-hrr", {
    description: "Generate HRR phase vectors for memories missing them",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(`🧠 Backfilling HRR vectors at dim=${hrrDim}...`, "info");
      try {
        const db = dbManager.getDb();
        const totalRow = db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
        const missingRow = db.prepare(
          "SELECT COUNT(*) AS c FROM memories WHERE hrr_vector IS NULL OR hrr_dim IS NULL OR hrr_dim != ?"
        ).get(hrrDim) as { c: number };

        if (missingRow.c === 0) {
          ctx.ui.notify(
            `✅ All ${totalRow.c} memories already have HRR vectors at dim=${hrrDim}. Nothing to do.`,
            "info",
          );
          return;
        }

        const start = Date.now();
        const updated = backfillHrrVectors(dbManager, hrrDim);
        const elapsedMs = Date.now() - start;

        let output = `\n✅ HRR backfill complete!\n\n`;
        output += `📊 Results:\n`;
        output += `├─ Total memories: ${totalRow.c}\n`;
        output += `├─ Updated: ${updated}\n`;
        output += `├─ Dimension: ${hrrDim} (≈${Math.round((hrrDim * 8) / 1024)} KB/row)\n`;
        output += `└─ Took: ${elapsedMs} ms\n`;
        output += `\n💡 Hybrid search now has full vector coverage on this store.`;
        ctx.ui.notify(output, "info");
      } catch (err) {
        ctx.ui.notify(
          `❌ HRR backfill failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
