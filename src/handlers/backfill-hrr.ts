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
import { backfillMessageHrrVectors } from "../store/session-search.js";
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
        const totalMem = (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
        const missingMem = (db.prepare(
          "SELECT COUNT(*) AS c FROM memories WHERE hrr_vector IS NULL OR hrr_dim IS NULL OR hrr_dim != ?"
        ).get(hrrDim) as { c: number }).c;
        const totalMsg = (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
        const missingMsg = (db.prepare(
          "SELECT COUNT(*) AS c FROM messages WHERE hrr_vector IS NULL OR hrr_dim IS NULL OR hrr_dim != ?"
        ).get(hrrDim) as { c: number }).c;

        if (missingMem === 0 && missingMsg === 0) {
          ctx.ui.notify(
            `✅ All ${totalMem} memories and ${totalMsg} messages already have HRR vectors at dim=${hrrDim}. Nothing to do.`,
            "info",
          );
          return;
        }

        const start = Date.now();

        const makeProgress = (label: string) => {
          let lastNotify = Date.now();
          return (processed: number, total: number) => {
            const now = Date.now();
            // Throttle to roughly once per second; always emit on completion.
            if (processed === total || now - lastNotify >= 1000) {
              lastNotify = now;
              const pct = total > 0 ? Math.floor((processed / total) * 100) : 100;
              ctx.ui.notify(`🧠 ${label}: ${processed}/${total} (${pct}%)`, "info");
            }
          };
        };

        const updatedMem = missingMem > 0
          ? backfillHrrVectors(dbManager, hrrDim, makeProgress("Memories"))
          : 0;
        const updatedMsg = missingMsg > 0
          ? backfillMessageHrrVectors(dbManager, hrrDim, makeProgress("Messages"))
          : 0;
        const elapsedMs = Date.now() - start;

        let output = `\n✅ HRR backfill complete!\n\n`;
        output += `📊 Results:\n`;
        output += `├─ Memories: ${updatedMem}/${totalMem} updated\n`;
        output += `├─ Messages: ${updatedMsg}/${totalMsg} updated\n`;
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
