/**
 * Auto-retrieval — automatically searches extended memory before each LLM call
 * and injects relevant entries into the context as a fenced <memory-context> block.
 *
 * Mirrors the prefetch pipeline in hermes-agent (MemoryManager.prefetch_all +
 * queue_prefetch_all): after each turn the user message is used to kick off a
 * background search; the result is consumed on the next turn's `context` event
 * and appended to the last user message so the cache-stable system prompt is
 * never touched.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DatabaseManager } from "../store/db.js";
import { searchMemories } from "../store/sqlite-memory-store.js";
import { extractContentTerms } from "../utils/stopwords.js";

const MIN_CONTENT_TERMS = 2;

const FENCE_OPEN = "<memory-context>";
const FENCE_CLOSE = "</memory-context>";
const MAX_RESULTS = 5;
const WIDGET_KEY = "hermes-memory-prefetch";
const WIDGET_MAX_CHARS = 140;

function buildMemoryContextBlock(entries: string[]): string {
  if (entries.length === 0) return "";
  const body = entries.map((e, i) => `${i + 1}. ${e}`).join("\n");
  return `${FENCE_OPEN}\nRelevant memories retrieved for this turn:\n${body}\n${FENCE_CLOSE}`;
}

function buildWidgetLines(entries: string[]): string[] {
  const header = `🧠 Prefetched memories (${entries.length})`;
  const body = entries.map((e, i) => {
    const oneLine = e.replace(/\s+/g, " ").trim();
    const truncated = oneLine.length > WIDGET_MAX_CHARS ? oneLine.slice(0, WIDGET_MAX_CHARS - 1) + "…" : oneLine;
    return `  ${i + 1}. ${truncated}`;
  });
  return [header, ...body];
}

import type { LiveSearchConfig } from '../calibration/search-config.js';

export function setupAutoRetrieval(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  temporalDecayHalfLifeDays = 0,
  frequencyBoost = false,
  liveConfig?: LiveSearchConfig,
): void {
  const jaccardWeight = () => liveConfig?.current.jaccardWeight ?? 0.3;
  const hrrWeight = () => liveConfig?.current.hrrWeight ?? 0.8;
  const ftsWeight = () => liveConfig?.current.ftsWeight ?? 0.15;
  const minScore = () => liveConfig?.current.minScore ?? 0.3;
  let prefetchedBlock = "";
  let prefetchPending = false;
  let lastCtx: ExtensionContext | undefined;

  // After each user message, kick off a background search using the message text as query.
  // Result is stored and consumed on the next context event.
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "user") return;
    lastCtx = ctx;

    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter((p: unknown) => (p as { type?: string }).type === "text").map((p: unknown) => (p as { text?: string }).text ?? "").join(" ")
        : "";

    const query = text.trim();
    if (!query) return;

    // Skip trivial conversational follow-ups: if the message has fewer than
    // MIN_CONTENT_TERMS non-stopword tokens, the query is too generic to
    // produce useful matches and will surface unrelated memories.
    const contentTerms = extractContentTerms(query);
    if (contentTerms.length < MIN_CONTENT_TERMS) {
      prefetchedBlock = "";
      if (lastCtx?.hasUI) {
        try { lastCtx.ui.setWidget(WIDGET_KEY, undefined); } catch { /* ignore */ }
      }
      return;
    }

    prefetchPending = true;

    // Run search in the background — don't await, just store result.
    //
    // No project scoping: relevance is judged purely on semantic score from
    // the hybrid FTS+Jaccard+HRR pipeline. Patterns learned in one project
    // should surface in another when the content is genuinely on-topic, and
    // a high minScore floor keeps unrelated entries out regardless of where
    // they were captured.
    Promise.resolve().then(() => {
      try {
        const results = searchMemories(dbManager, query, {
          limit: MAX_RESULTS,
          temporalDecayHalfLifeDays: liveConfig?.current.temporalDecayHalfLifeDays ?? temporalDecayHalfLifeDays,
          frequencyBoost,
          ftsWeight: ftsWeight(),
          jaccardWeight: jaccardWeight(),
          hrrWeight: hrrWeight(),
          minScore: minScore(),
        });
        const contents = results.map((r) => r.content);
        if (contents.length > 0) {
          prefetchedBlock = buildMemoryContextBlock(contents);
          if (lastCtx?.hasUI) {
            try { lastCtx.ui.setWidget(WIDGET_KEY, buildWidgetLines(contents), { placement: "aboveEditor" }); } catch { /* ignore */ }
          }
        } else {
          prefetchedBlock = "";
          if (lastCtx?.hasUI) {
            try { lastCtx.ui.setWidget(WIDGET_KEY, undefined); } catch { /* ignore */ }
          }
        }
      } catch {
        prefetchedBlock = "";
      } finally {
        prefetchPending = false;
      }
    });
  });

  // Before each provider request, inject the prefetched block into the last user message.
  pi.on("context", async (_event, _ctx) => {
    if (!prefetchedBlock) return;

    const block = prefetchedBlock;
    prefetchedBlock = ""; // consume once

    const messages = (_event as { messages?: unknown[] }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    // Find the last user message and append the memory block to it
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as { role?: string; content?: unknown };
      if (msg.role !== "user") continue;

      if (typeof msg.content === "string") {
        msg.content = msg.content + "\n\n" + block;
      } else if (Array.isArray(msg.content)) {
        msg.content = [...msg.content, { type: "text", text: block }];
      }
      break;
    }

    return { messages };
  });
}
