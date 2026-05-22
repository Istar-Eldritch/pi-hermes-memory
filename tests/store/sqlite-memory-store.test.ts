import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import {
  addMemory,
  searchMemories,
  getMemories,
  removeMemory,
  touchMemory,
  getMemoryStats,
  syncMemoryEntry,
  replaceSyncedMemories,
  removeSyncedMemories,
  parseMarkdownMemoryEntry,
  formatFailureMemoryContent,
} from '../../src/store/sqlite-memory-store.js';

describe('sqlite-memory-store', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-test-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('addMemory', () => {
    it('should add a memory entry', () => {
      const entry = addMemory(dbManager, 'prefers pnpm over npm');
      assert.ok(entry.id > 0);
      assert.strictEqual(entry.target, 'memory');
      assert.strictEqual(entry.content, 'prefers pnpm over npm');
      assert.ok(entry.created.length > 0);
      assert.ok(entry.lastReferenced.length > 0);
    });

    it('should add a user entry', () => {
      const entry = addMemory(dbManager, 'name: Chandrateja', 'user');
      assert.strictEqual(entry.target, 'user');
    });

    it('should add a project-specific entry', () => {
      const entry = addMemory(dbManager, 'uses Prisma', 'memory', 'my-project');
      assert.strictEqual(entry.project, 'my-project');
    });

    it('should add a global entry (null project)', () => {
      const entry = addMemory(dbManager, 'timezone: AEST');
      assert.strictEqual(entry.project, null);
    });
  });

  describe('syncMemoryEntry', () => {
    it('deduplicates exact logical entries', () => {
      const first = syncMemoryEntry(dbManager, {
        content: 'prefers pnpm over npm',
        target: 'memory',
      });
      const second = syncMemoryEntry(dbManager, {
        content: 'prefers pnpm over npm',
        target: 'memory',
      });

      assert.strictEqual(first.action, 'inserted');
      assert.strictEqual(second.action, 'existing');
      assert.strictEqual(getMemories(dbManager).length, 1);
    });

    it('stores project-scoped memory with project name', () => {
      syncMemoryEntry(dbManager, {
        content: 'uses Prisma',
        target: 'memory',
        project: 'project-a',
      });

      const results = getMemories(dbManager, { project: 'project-a' });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].project, 'project-a');
      assert.strictEqual(results[0].target, 'memory');
    });

    it('preserves failure category metadata', () => {
      syncMemoryEntry(dbManager, {
        content: formatFailureMemoryContent('pnpm lockfile mismatch', {
          category: 'tool-quirk',
          failureReason: 'npm install rewrote lockfile',
        }),
        target: 'failure',
        category: 'tool-quirk',
        failureReason: 'npm install rewrote lockfile',
      });

      const results = getMemories(dbManager, { target: 'failure', category: 'tool-quirk' });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].category, 'tool-quirk');
      assert.strictEqual(results[0].failureReason, 'npm install rewrote lockfile');
    });

    it('parses Markdown failure entries for backfill', () => {
      const parsed = parseMarkdownMemoryEntry(
        '[correction] use pnpm — Failed: npm install rewrote lockfile <!-- created=2026-05-08, last=2026-05-09 -->',
        'failure',
      );

      assert.strictEqual(parsed.category, 'correction');
      assert.strictEqual(parsed.failureReason, 'npm install rewrote lockfile');
      assert.strictEqual(parsed.created, '2026-05-08');
      assert.strictEqual(parsed.lastReferenced, '2026-05-09');
    });
  });

  describe('replace/remove synced memories', () => {
    it('escapes % and _ during replace matching', () => {
      addMemory(dbManager, 'token 100%_safe value');
      addMemory(dbManager, 'token 100XXsafe value');

      const result = replaceSyncedMemories(dbManager, '100%_safe', {
        content: 'token updated literal value',
        target: 'memory',
        project: null,
      });

      assert.strictEqual(result.matched, 1);
      const all = getMemories(dbManager);
      assert.ok(all.some((entry) => entry.content === 'token updated literal value'));
      assert.ok(all.some((entry) => entry.content === 'token 100XXsafe value'));
    });

    it('escapes % and _ during remove matching', () => {
      addMemory(dbManager, 'remove 50%_match literal');
      addMemory(dbManager, 'remove 50AAmatch literal');

      const result = removeSyncedMemories(dbManager, '50%_match', {
        target: 'memory',
        project: null,
      });

      assert.strictEqual(result.matched, 1);
      const all = getMemories(dbManager);
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].content, 'remove 50AAmatch literal');
    });
  });

  describe('searchMemories', () => {
    beforeEach(() => {
      addMemory(dbManager, 'prefers pnpm over npm');
      addMemory(dbManager, 'uses Prisma with PostgreSQL', 'memory', 'project-a');
      addMemory(dbManager, 'name: Chandrateja', 'user');
      addMemory(dbManager, 'timezone: AEST', 'user');
    });

    it('should find memories by keyword', () => {
      const results = searchMemories(dbManager, 'pnpm');
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.content.includes('pnpm')));
    });

    it('should find memories by partial content', () => {
      const results = searchMemories(dbManager, 'Prisma');
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.content.includes('Prisma')));
    });

    it('should limit results', () => {
      const results = searchMemories(dbManager, 'pnpm OR Prisma OR AEST', { limit: 2 });
      assert.ok(results.length <= 2);
    });

    it('should filter by project', () => {
      const results = searchMemories(dbManager, 'Prisma', { project: 'project-a' });
      assert.ok(results.length > 0);
      assert.ok(results.every(r => r.project === 'project-a'));
    });

    it('should filter by target', () => {
      const results = searchMemories(dbManager, 'Chandrateja OR AEST', { target: 'user' });
      assert.ok(results.length > 0);
      assert.ok(results.every(r => r.target === 'user'));
    });

    it('should return empty for no matches', () => {
      const results = searchMemories(dbManager, 'nonexistent-xyz');
      assert.strictEqual(results.length, 0);
    });

    describe('temporal decay scoring', () => {
      it('ranks recent entry above old entry for same relevance when decay is aggressive', () => {
        const db = dbManager.getDb();

        // Two entries with identical content to equalize BM25 scores
        const old = addMemory(dbManager, 'deployment workflow steps alpha');
        const recent = addMemory(dbManager, 'deployment workflow steps alpha');

        // Age the first entry to 180 days ago
        const oldDate = new Date(Date.now() - 180 * 86_400_000).toISOString().split('T')[0];
        db.prepare('UPDATE memories SET last_referenced = ? WHERE id = ?').run(oldDate, old.id);

        // half-life of 30 days — 180-day-old entry decays to 0.5^6 ≈ 0.016
        const results = searchMemories(dbManager, 'deployment workflow', { temporalDecayHalfLifeDays: 30 });
        const ids = results.map(r => r.id);
        assert.ok(ids.indexOf(recent.id) < ids.indexOf(old.id), 'recent entry should rank above old entry');
      });

      it('returns at most `limit` results when decay is active', () => {
        for (let i = 0; i < 6; i++) {
          addMemory(dbManager, `authentication token refresh cycle ${i}`);
        }
        const results = searchMemories(dbManager, 'authentication token', { limit: 3, temporalDecayHalfLifeDays: 30 });
        assert.ok(results.length <= 3);
      });

      it('preserves BM25 order when decay is disabled (halfLife = 0)', () => {
        // Without decay the function should still return results
        const results = searchMemories(dbManager, 'pnpm', { temporalDecayHalfLifeDays: 0 });
        assert.ok(results.length > 0);
      });
    });

    describe('frequency boost scoring', () => {
      it('ranks high-rate entry above a high-count-but-old entry when frequencyBoost is enabled', () => {
        const db = dbManager.getDb();

        // Old entry: 100 hits over 365 days ≈ 0.27/day
        const old = addMemory(dbManager, 'deployment pipeline configuration steps');
        const oldDate = new Date(Date.now() - 365 * 86_400_000).toISOString().split('T')[0];
        db.prepare('UPDATE memories SET created = ?, reference_count = 100 WHERE id = ?').run(oldDate, old.id);

        // Recent entry: 10 hits over 7 days ≈ 1.43/day
        const recent = addMemory(dbManager, 'deployment pipeline configuration steps');
        const recentDate = new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0];
        db.prepare('UPDATE memories SET created = ?, reference_count = 10 WHERE id = ?').run(recentDate, recent.id);

        const results = searchMemories(dbManager, 'deployment pipeline', { frequencyBoost: true });
        const ids = results.map(r => r.id);
        assert.ok(ids.indexOf(recent.id) < ids.indexOf(old.id), 'high-rate entry should rank above high-count-but-old entry');
      });

      it('preserves order when frequencyBoost is disabled', () => {
        const withBoost = searchMemories(dbManager, 'pnpm', { frequencyBoost: false });
        const withoutBoost = searchMemories(dbManager, 'pnpm', {});
        assert.deepStrictEqual(withBoost.map(r => r.id), withoutBoost.map(r => r.id));
      });

      it('increments reference_count on touchMemory', () => {
        const entry = addMemory(dbManager, 'some fact worth touching');
        assert.strictEqual(entry.referenceCount, 1);

        touchMemory(dbManager, entry.id);
        touchMemory(dbManager, entry.id);

        const db = dbManager.getDb();
        const row = db.prepare('SELECT reference_count FROM memories WHERE id = ?').get(entry.id) as { reference_count: number };
        assert.strictEqual(row.reference_count, 3);
      });
    });
  });

  describe('getMemories', () => {
    beforeEach(() => {
      addMemory(dbManager, 'global memory 1');
      addMemory(dbManager, 'global memory 2');
      addMemory(dbManager, 'project memory', 'memory', 'project-a');
      addMemory(dbManager, 'user preference', 'user');
    });

    it('should return all memories', () => {
      const results = getMemories(dbManager);
      assert.strictEqual(results.length, 4);
    });

    it('should filter by project', () => {
      const results = getMemories(dbManager, { project: 'project-a' });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].content, 'project memory');
    });

    it('should filter by null project (global)', () => {
      const results = getMemories(dbManager, { project: null });
      assert.strictEqual(results.length, 3);
    });

    it('should filter by target', () => {
      const results = getMemories(dbManager, { target: 'user' });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].content, 'user preference');
    });
  });

  describe('removeMemory', () => {
    it('should remove a memory by id', () => {
      const entry = addMemory(dbManager, 'to be removed');
      const removed = removeMemory(dbManager, entry.id);
      assert.strictEqual(removed, true);

      const all = getMemories(dbManager);
      assert.strictEqual(all.length, 0);
    });

    it('should return false for non-existent id', () => {
      const removed = removeMemory(dbManager, 99999);
      assert.strictEqual(removed, false);
    });
  });

  describe('touchMemory', () => {
    it('should update last_referenced date', () => {
      const entry = addMemory(dbManager, 'old memory');
      // Manually set an old date
      const db = dbManager.getDb();
      db.prepare('UPDATE memories SET last_referenced = ? WHERE id = ?').run('2020-01-01', entry.id);

      touchMemory(dbManager, entry.id);

      const updated = db.prepare('SELECT last_referenced FROM memories WHERE id = ?').get(entry.id) as { last_referenced: string };
      const today = new Date().toISOString().split('T')[0];
      assert.strictEqual(updated.last_referenced, today);
    });
  });

  describe('getMemoryStats', () => {
    it('should return zero stats for empty database', () => {
      const stats = getMemoryStats(dbManager);
      assert.strictEqual(stats.total, 0);
      assert.deepStrictEqual(stats.byProject, []);
      assert.deepStrictEqual(stats.byTarget, []);
    });

    it('should return correct stats', () => {
      addMemory(dbManager, 'global 1');
      addMemory(dbManager, 'global 2');
      addMemory(dbManager, 'project memory', 'memory', 'project-a');
      addMemory(dbManager, 'user pref', 'user');

      const stats = getMemoryStats(dbManager);
      assert.strictEqual(stats.total, 4);
      assert.strictEqual(stats.byTarget.length, 2);
      assert.ok(stats.byProject.length > 0);
    });
  });
});
