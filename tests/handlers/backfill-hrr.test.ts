import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { addMemory } from "../../src/store/sqlite-memory-store.js";
import { registerBackfillHrrCommand } from "../../src/handlers/backfill-hrr.js";

describe("registerBackfillHrrCommand", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-hrr-test-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    const registered: { name: string; handler: Function }[] = [];
    const notifyCalls: { message: string; severity: string }[] = [];
    const pi = {
      registerCommand: (name: string, conf: { handler: Function }) => {
        registered.push({ name, handler: conf.handler });
      },
    } as any;
    registerBackfillHrrCommand(pi, dbManager);
    const ctx = {
      ui: {
        notify: (message: string, severity: string) => notifyCalls.push({ message, severity }),
      },
    };
    return { handler: registered[0].handler, ctx, notifyCalls };
  }

  it("registers the /memory-backfill-hrr command", () => {
    const { handler } = setup();
    assert.ok(typeof handler === "function");
  });

  it("reports nothing-to-do when every memory already has a vector", async () => {
    addMemory(dbManager, "one"); // addMemory now encodes by default
    const { handler, ctx, notifyCalls } = setup();
    await handler({}, ctx);
    assert.ok(notifyCalls.some((c) => /already have HRR vectors/.test(c.message)));
  });

  it("backfills rows that are missing vectors", async () => {
    addMemory(dbManager, "fact one");
    addMemory(dbManager, "fact two");
    const db = dbManager.getDb();
    db.exec("UPDATE memories SET hrr_vector = NULL, hrr_dim = NULL");

    const { handler, ctx, notifyCalls } = setup();
    await handler({}, ctx);

    const remaining = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE hrr_vector IS NULL").get() as { c: number };
    assert.strictEqual(remaining.c, 0);
    assert.ok(notifyCalls.some((c) => /Memories: 2\/\d+ updated/.test(c.message)));
  });
});
