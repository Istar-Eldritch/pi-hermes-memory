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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DatabaseManager } from "../store/db.js";
import { searchMemories } from "../store/sqlite-memory-store.js";

const FENCE_OPEN = "<memory-context>";
const FENCE_CLOSE = "</memory-context>";
const MAX_RESULTS = 5;

function buildMemoryContextBlock(entries: string[]): string {
  if (entries.length === 0) return "";
  const body = entries.map((e, i) => `${i + 1}. ${e}`).join("\n");
  return `${FENCE_OPEN}\nRelevant memories retrieved for this turn:\n${body}\n${FENCE_CLOSE}`;
}

export function setupAutoRetrieval(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  temporalDecayHalfLifeDays = 0,
  frequencyBoost = false,
): void {
  let prefetchedBlock = "";
  let prefetchPending = false;

  // After each user message, kick off a background search using the message text as query.
  // Result is stored and consumed on the next context event.
  pi.on("message_end", async (event, _ctx) => {
    const msg = event.message;
    if (msg.role !== "user") return;

    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter((p: unknown) => (p as { type?: string }).type === "text").map((p: unknown) => (p as { text?: string }).text ?? "").join(" ")
        : "";

    const query = text.trim();
    if (!query) return;

    prefetchPending = true;

    // Run search in the background — don't await, just store result
    Promise.resolve().then(() => {
      try {
        const results = searchMemories(dbManager, query, { limit: MAX_RESULTS, temporalDecayHalfLifeDays, frequencyBoost });
        if (results.length > 0) {
          prefetchedBlock = buildMemoryContextBlock(results.map((r) => r.content));
        } else {
          prefetchedBlock = "";
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
