import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAtom,
  encodeText,
  bind,
  unbind,
  bundle,
  similarity,
  phasesToBytes,
  bytesToPhases,
  DEFAULT_HRR_DIM,
} from "../../src/store/hrr.js";

describe("hrr primitives", () => {
  it("encodeAtom is deterministic and shape-correct", () => {
    const a = encodeAtom("pnpm");
    const b = encodeAtom("pnpm");
    assert.strictEqual(a.length, DEFAULT_HRR_DIM);
    for (let i = 0; i < a.length; i++) assert.strictEqual(a[i], b[i]);
  });

  it("encodeAtom values are in [0, 2π)", () => {
    const v = encodeAtom("anything", 256);
    for (let i = 0; i < v.length; i++) {
      assert.ok(v[i] >= 0);
      assert.ok(v[i] < 2 * Math.PI + 1e-9);
    }
  });

  it("different atoms are approximately orthogonal", () => {
    const a = encodeAtom("apple");
    const b = encodeAtom("zebra");
    const sim = similarity(a, b);
    assert.ok(Math.abs(sim) < 0.1, `expected near-zero similarity, got ${sim}`);
  });

  it("identical vectors have similarity 1.0", () => {
    const a = encodeAtom("word");
    assert.ok(Math.abs(similarity(a, a) - 1.0) < 1e-12);
  });

  it("bind then unbind recovers the value (approximately)", () => {
    const a = encodeAtom("key");
    const b = encodeAtom("value");
    const bound = bind(a, b);
    const recovered = unbind(bound, a);
    const sim = similarity(recovered, b);
    assert.ok(sim > 0.99, `expected ~1.0, got ${sim}`);
  });

  it("encodeText similar texts score higher than unrelated", () => {
    const q = encodeText("user prefers pnpm");
    const related = encodeText("user prefers pnpm over npm");
    const unrelated = encodeText("zebras roam the savannah at dusk");
    const simRelated = similarity(q, related);
    const simUnrelated = similarity(q, unrelated);
    assert.ok(simRelated > simUnrelated, `related (${simRelated}) should beat unrelated (${simUnrelated})`);
    assert.ok(simRelated > 0.3, `expected reasonable overlap, got ${simRelated}`);
  });

  it("bundle is similar to each input", () => {
    const a = encodeAtom("apple");
    const b = encodeAtom("banana");
    const c = encodeAtom("cherry");
    const merged = bundle([a, b, c]);
    assert.ok(similarity(merged, a) > 0.3);
    assert.ok(similarity(merged, b) > 0.3);
    assert.ok(similarity(merged, c) > 0.3);
    assert.ok(similarity(merged, encodeAtom("nothing")) < 0.3);
  });

  it("phases round-trip through bytes", () => {
    const v = encodeText("the quick brown fox");
    const bytes = phasesToBytes(v);
    assert.strictEqual(bytes.length, v.length * 8);
    const back = bytesToPhases(bytes);
    assert.strictEqual(back.length, v.length);
    for (let i = 0; i < v.length; i++) {
      assert.ok(Math.abs(v[i] - back[i]) < 1e-12);
    }
    assert.ok(similarity(v, back) > 0.999999);
  });

  it("empty text encodes as the sentinel atom", () => {
    const a = encodeText("");
    const b = encodeText("   ");
    const sentinel = encodeAtom("__hrr_empty__");
    assert.ok(similarity(a, sentinel) > 0.999999);
    assert.ok(similarity(b, sentinel) > 0.999999);
  });
});
