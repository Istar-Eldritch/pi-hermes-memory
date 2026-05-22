/**
 * Holographic Reduced Representations (HRR) with phase encoding.
 *
 * Ported from hermes-agent's plugins/memory/holographic/holographic.py.
 * Concepts are vectors of phases in [0, 2π). Operations:
 *   - bind   = element-wise phase addition (mod 2π)
 *   - unbind = element-wise phase subtraction (mod 2π)
 *   - bundle = circular mean of complex exponentials (superposition)
 *   - similarity = mean of cos(a - b), range [-1, 1]
 *
 * Atoms are generated deterministically from SHA-256 so the same word always
 * encodes to the same vector across processes and machines.
 */

import { createHash } from "node:crypto";

const TWO_PI = 2 * Math.PI;
const VALUES_PER_BLOCK = 16; // each sha256 digest = 32 bytes = 16 uint16
const SCALE = TWO_PI / 65536;

export const DEFAULT_HRR_DIM = 512;

function sha256Bytes(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

export function encodeAtom(word: string, dim: number = DEFAULT_HRR_DIM): Float64Array {
  const blocks = Math.ceil(dim / VALUES_PER_BLOCK);
  const out = new Float64Array(dim);
  let idx = 0;
  for (let b = 0; b < blocks && idx < dim; b++) {
    const digest = sha256Bytes(`${word}:${b}`);
    for (let i = 0; i < VALUES_PER_BLOCK && idx < dim; i++) {
      const lo = digest[i * 2];
      const hi = digest[i * 2 + 1];
      const u16 = lo | (hi << 8);
      out[idx++] = u16 * SCALE;
    }
  }
  return out;
}

function tokenizeForHrr(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.toLowerCase().split(/\s+/)) {
    const cleaned = word.replace(/^[.,!?;:"'()\[\]{}<>#@]+|[.,!?;:"'()\[\]{}<>#@]+$/g, "");
    if (cleaned) tokens.push(cleaned);
  }
  return tokens;
}

export function bundle(vectors: Float64Array[]): Float64Array {
  if (vectors.length === 0) throw new Error("bundle requires at least one vector");
  const dim = vectors[0].length;
  const reSum = new Float64Array(dim);
  const imSum = new Float64Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      reSum[i] += Math.cos(v[i]);
      imSum[i] += Math.sin(v[i]);
    }
  }
  const out = new Float64Array(dim);
  for (let i = 0; i < dim; i++) {
    let angle = Math.atan2(imSum[i], reSum[i]);
    if (angle < 0) angle += TWO_PI;
    out[i] = angle;
  }
  return out;
}

export function encodeText(text: string, dim: number = DEFAULT_HRR_DIM): Float64Array {
  const tokens = tokenizeForHrr(text);
  if (tokens.length === 0) return encodeAtom("__hrr_empty__", dim);
  const atoms = tokens.map((t) => encodeAtom(t, dim));
  return bundle(atoms);
}

export function bind(a: Float64Array, b: Float64Array): Float64Array {
  const dim = a.length;
  const out = new Float64Array(dim);
  for (let i = 0; i < dim; i++) {
    let v = a[i] + b[i];
    v %= TWO_PI;
    if (v < 0) v += TWO_PI;
    out[i] = v;
  }
  return out;
}

export function unbind(memory: Float64Array, key: Float64Array): Float64Array {
  const dim = memory.length;
  const out = new Float64Array(dim);
  for (let i = 0; i < dim; i++) {
    let v = memory[i] - key[i];
    v %= TWO_PI;
    if (v < 0) v += TWO_PI;
    out[i] = v;
  }
  return out;
}

export function similarity(a: Float64Array, b: Float64Array): number {
  const dim = a.length;
  if (dim === 0 || b.length !== dim) return 0;
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    sum += Math.cos(a[i] - b[i]);
  }
  return sum / dim;
}

export function phasesToBytes(phases: Float64Array): Buffer {
  return Buffer.from(phases.buffer, phases.byteOffset, phases.byteLength);
}

export function bytesToPhases(data: Buffer | Uint8Array): Float64Array {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const copy = Buffer.from(buf);
  return new Float64Array(copy.buffer, copy.byteOffset, copy.byteLength / 8);
}
