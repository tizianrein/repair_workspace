/**
 * Vector search — the arithmetic, offline.
 *
 * This exists because of a bug that shipped and was invisible. `embedQuery`
 * returns float components of a unit-length vector, every one of them between
 * -1 and 1. The Worker read the query with `Int8Array.from(query)`, which
 * truncates toward zero — so every component became 0, every chunk scored
 * exactly 0, `sort()` on all-equal scores did nothing, and semantic search
 * returned whatever order D1 handed back.
 *
 * Nothing threw. Nothing logged. The hybrid path meant lexical results still
 * came through, so the feature looked alive while the half of it this project
 * is actually about — reaching a document phrased in a vocabulary the query
 * does not share — was returning noise.
 *
 * The lesson these tests encode: a similarity function must be checked against
 * known answers, not merely against "it returned some results".
 */

import assert from 'node:assert';
import { quantize, quantizeVector, toUnitInt8 } from '../api/_shared/embeddings.js';
import { decodeVector, toQueryVector, dot } from '../cloudflare/worker.js';

console.log('\n=== VECTOR SEARCH ===');

const DIMS = 768;

// A deterministic pseudo-random unit vector, so failures are reproducible.
function fakeEmbedding(seed) {
  let s = seed;
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    v[i] = (s / 4294967296) * 2 - 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIMS; i++) v[i] /= norm;
  return Array.from(v);
}

function trueCosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

// Score a stored chunk against a query exactly as handleSearchCorpus does.
function score(storedFloats, queryValues) {
  return dot(toQueryVector(queryValues), decodeVector(quantize(storedFloats))) / (127 * 127);
}

// --- the regression itself ------------------------------------------------

const q = fakeEmbedding(1);

assert.deepStrictEqual(
  Array.from(Int8Array.from([0.9, -0.4, 0.02])), [0, 0, 0],
  'premise of the bug: Int8Array.from truncates unit-interval floats to zero',
);

const asFloats = toQueryVector(q);
assert.ok(
  asFloats.some(x => x !== 0),
  'a raw float query vector must not collapse to all zeros',
);
console.log('✓ raw float query survives (non-zero components:',
  asFloats.filter(x => x !== 0).length, 'of', DIMS + ')');

// Whichever form the API posts — floats or already quantised — the Worker must
// rank identically. The two deploy independently, so both forms will occur.
const viaFloats = score(q, q);
const viaQuantised = score(q, quantizeVector(q));
assert.ok(
  Math.abs(viaFloats - viaQuantised) < 1e-9,
  `float and pre-quantised query must score alike (${viaFloats} vs ${viaQuantised})`,
);
console.log('✓ float and pre-quantised queries rank identically');

// --- the arithmetic is actually cosine ------------------------------------

const self = score(q, q);
assert.ok(self > 0.99, `a vector against itself should be ~1.0, got ${self}`);
console.log(`✓ self-similarity ${self.toFixed(4)}`);

for (const seed of [2, 7, 99, 12345]) {
  const other = fakeEmbedding(seed);
  const got = score(other, q);
  const want = trueCosine(other, q);
  assert.ok(
    Math.abs(got - want) < 0.01,
    `int8 cosine should track float cosine within 0.01: got ${got}, want ${want}`,
  );
}
console.log('✓ int8 dot product reproduces float cosine within 0.01');

// A retriever that cannot separate near from far is not retrieving. Build a
// vector deliberately close to the query and confirm it outranks a random one.
const near = q.map((x, i) => x + (fakeEmbedding(5)[i] * 0.15));
const far = fakeEmbedding(31);
assert.ok(
  score(near, q) > score(far, q),
  'a near vector must outrank a far one',
);
console.log(`✓ ranking separates near (${score(near, q).toFixed(3)}) from far (${score(far, q).toFixed(3)})`);

// --- quantisation invariants ----------------------------------------------

const int8 = toUnitInt8(q);
assert.strictEqual(int8.length, DIMS, 'quantisation must preserve dimensionality');
assert.ok(int8 instanceof Int8Array);
assert.ok(Math.max(...int8) <= 127 && Math.min(...int8) >= -127, 'components stay in int8 range');

// Round-trip through base64 storage without loss.
const roundTripped = decodeVector(quantize(q));
assert.deepStrictEqual(
  Array.from(roundTripped), Array.from(int8),
  'base64 storage round-trip must be lossless',
);
console.log('✓ base64 round-trip is lossless and dimension-preserving');

// An unnormalised vector must land in the same place as its normalised twin,
// or documents embedded at different magnitudes would rank by magnitude.
const scaled = q.map(x => x * 37.5);
assert.deepStrictEqual(
  quantizeVector(scaled), quantizeVector(q),
  'quantisation must normalise, so magnitude cannot influence ranking',
);
console.log('✓ magnitude does not influence ranking');

console.log('\n✓ Vector search arithmetic is correct\n');
