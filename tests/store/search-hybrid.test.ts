import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { addMemory, searchMemories, backfillHrrVectors } from "../../src/store/sqlite-memory-store.js";

describe("searchMemories — hybrid HRR + Jaccard reranking", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-hybrid-"));
    dbManager = new DatabaseManager(tmpDir);
    addMemory(dbManager, "user prefers pnpm over npm for new projects");
    addMemory(dbManager, "uses Prisma with PostgreSQL in production");
    addMemory(dbManager, "always run pytest before committing");
    addMemory(dbManager, "completely unrelated note about cats and naps");
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("default behaviour is unchanged when no rerank weights are set", () => {
    const r = searchMemories(dbManager, "pnpm");
    assert.ok(r.length > 0);
    assert.ok(r[0].content.includes("pnpm"));
  });

  it("HRR-only mode returns results for long natural-language queries that FTS5 alone would miss", () => {
    // This sentence has very low FTS overlap with the memory entry, because
    // implicit AND would require every word to appear. HRR rescues it.
    const long = "which package manager should I default to for new node projects";
    const ftsOnly = searchMemories(dbManager, long);
    assert.strictEqual(ftsOnly.length, 0, "baseline FTS should miss this query");

    const hybrid = searchMemories(dbManager, long, { hrrWeight: 1, ftsWeight: 0, limit: 3 });
    assert.ok(hybrid.length > 0, "HRR rerank should surface candidates");
    assert.ok(hybrid[0].content.toLowerCase().includes("pnpm"), `expected pnpm memory first, got ${hybrid[0].content}`);
  });

  it("Jaccard rerank boosts partial overlaps over irrelevant candidates", () => {
    // Pass a query where FTS does return *something* but with multiple terms;
    // jaccard weight should keep the most semantically overlapping at the top.
    addMemory(dbManager, "pnpm is faster than npm and yarn");
    const r = searchMemories(dbManager, "pnpm npm", {
      jaccardWeight: 1,
      ftsWeight: 0.5,
      limit: 3,
    });
    assert.ok(r.length > 0);
    assert.ok(r[0].content.includes("pnpm") && r[0].content.includes("npm"));
  });

  it("HRR candidate cap limits how many rows are scored", () => {
    // Add many irrelevant rows so the cap matters.
    for (let i = 0; i < 50; i++) addMemory(dbManager, `random filler row number ${i}`);
    const r = searchMemories(dbManager, "completely unrelated query xyz", {
      hrrWeight: 1,
      ftsWeight: 0,
      limit: 5,
      hrrCandidateCap: 10,
    });
    assert.ok(r.length <= 5);
  });

  it("backfillHrrVectors fills vectors for rows missing them", () => {
    // Simulate legacy rows by clearing vectors.
    const db = (dbManager as unknown as { getDb: () => { exec: (s: string) => void; prepare: (s: string) => { get: () => { c: number } } } }).getDb();
    db.exec("UPDATE memories SET hrr_vector = NULL, hrr_dim = NULL");
    const missingBefore = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE hrr_vector IS NULL").get() as { c: number };
    assert.ok(missingBefore.c > 0);

    const n = backfillHrrVectors(dbManager);
    assert.strictEqual(n, missingBefore.c);

    const missingAfter = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE hrr_vector IS NULL").get() as { c: number };
    assert.strictEqual(missingAfter.c, 0);
  });
});
