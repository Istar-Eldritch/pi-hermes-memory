import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { addMemory } from "../../src/store/sqlite-memory-store.js";
import { setupAutoRetrieval } from "../../src/handlers/auto-retrieval.js";

type Handler = (event: any, ctx: any) => any;

function makePi() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, h: Handler) => { handlers.set(name, h); },
  } as any;
  return { pi, handlers };
}

function makeCtx() {
  const widgetCalls: { key: string; content: any; options?: any }[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (key: string, content: any, options?: any) => {
        widgetCalls.push({ key, content, options });
      },
    },
  };
  return { ctx, widgetCalls };
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("setupAutoRetrieval", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-retrieval-test-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets the prefetch widget when memories match", async () => {
    addMemory(dbManager, "user prefers pnpm over npm");
    addMemory(dbManager, "use vitest for new tests");

    const { pi, handlers } = makePi();
    const { ctx, widgetCalls } = makeCtx();
    setupAutoRetrieval(pi, dbManager);

    await handlers.get("message_end")!(
      { message: { role: "user", content: "pnpm" } },
      ctx,
    );
    await flushMicrotasks();

    assert.ok(widgetCalls.length >= 1, "expected setWidget to be called");
    const call = widgetCalls.at(-1)!;
    assert.strictEqual(call.key, "hermes-memory-prefetch");
    assert.ok(Array.isArray(call.content));
    assert.match(call.content[0], /Prefetched memories/);
    assert.ok(call.content.slice(1).some((l: string) => l.includes("pnpm")));
    assert.strictEqual(call.options?.placement, "aboveEditor");
  });

  it("clears the widget when there are no matches", async () => {
    addMemory(dbManager, "completely unrelated fact about cats");

    const { pi, handlers } = makePi();
    const { ctx, widgetCalls } = makeCtx();
    setupAutoRetrieval(pi, dbManager);

    await handlers.get("message_end")!(
      { message: { role: "user", content: "zzzzzzzzz_nomatch_token_xyz" } },
      ctx,
    );
    await flushMicrotasks();

    const last = widgetCalls.at(-1);
    assert.ok(last, "expected at least one setWidget call");
    assert.strictEqual(last!.content, undefined);
  });

  it("injects the memory block into the last user message on context", async () => {
    addMemory(dbManager, "user prefers pnpm over npm");

    const { pi, handlers } = makePi();
    const { ctx } = makeCtx();
    setupAutoRetrieval(pi, dbManager);

    await handlers.get("message_end")!(
      { message: { role: "user", content: "pnpm" } },
      ctx,
    );
    await flushMicrotasks();

    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "pnpm" },
    ];
    const result = await handlers.get("context")!({ messages }, ctx);
    const out = result?.messages ?? messages;
    const lastUser = out[out.length - 1];
    assert.match(String(lastUser.content), /<memory-context>/);
    assert.match(String(lastUser.content), /pnpm/);
  });

  it("ignores non-user messages", async () => {
    addMemory(dbManager, "user prefers pnpm over npm");

    const { pi, handlers } = makePi();
    const { ctx, widgetCalls } = makeCtx();
    setupAutoRetrieval(pi, dbManager);

    await handlers.get("message_end")!(
      { message: { role: "assistant", content: "ok" } },
      ctx,
    );
    await flushMicrotasks();

    assert.strictEqual(widgetCalls.length, 0);
  });
});
