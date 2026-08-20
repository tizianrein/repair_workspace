/**
 * ZIP bundle round-trip test.
 *
 * The exporter filtered on `kind === 'photo'`, so AI-generated renderings were
 * written into workspace.json as references with no bytes behind them — a
 * Save → Load cycle silently lost every imagined result. There was no
 * round-trip test to catch it.
 *
 * Runs headless: JSZip works in Node, and PhotoStorage is stubbed with an
 * in-memory map standing in for IndexedDB.
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));

// --- stub PhotoStorage (IndexedDB) via a loader hook --------------------
const STUB = `
const mem = new Map();
export const PhotoStorage = {
  async init() {},
  async put(id, blob, name) { mem.set(id, { id, blob, name, mime: blob.type, createdAt: new Date().toISOString() }); },
  async get(id) { return mem.get(id) || null; },
  async delete(id) { mem.delete(id); },
  async clear() { mem.clear(); },
  _mem: mem,
};
`;
register(
  'data:text/javascript,' + encodeURIComponent(`
    export async function resolve(spec, ctx, next) {
      if (spec.endsWith('photo-storage.js')) return { url: 'stub:photo-storage', shortCircuit: true };
      return next(spec, ctx);
    }
    export async function load(url, ctx, next) {
      if (url === 'stub:photo-storage')
        return { format: 'module', shortCircuit: true, source: ${JSON.stringify(STUB)} };
      return next(url, ctx);
    }
  `),
  import.meta.url
);

const { exportWorkspaceBundle, importWorkspaceBundle, binaryEvidence } =
  await import('../src/core/workspace-bundle.js');
const { PhotoStorage } = await import('../src/core/photo-storage.js');
const { newWorkspace, newPlan, newEvidence, newCondition } = await import('../src/core/schema.js');

console.log('\n=== WORKSPACE BUNDLE ROUND TRIP ===\n');

// --- build a workspace with a photo AND a rendering ---------------------
const ws = newWorkspace();
ws.instance.name = 'Nordportal';
const plan = newPlan({ label: 'Splice and consolidate' });
ws.plans = [plan];
ws.currentPlanId = plan.id;

const condition = newCondition({ description: 'rot at sill', partRef: 'sill' });
ws.conditions = [condition];

const photo = newEvidence('photo', {
  attachedTo: { type: 'condition', id: condition.id },
  url: 'idb://x', fileName: 'sill.jpg',
});
const rendering = newEvidence('rendering', {
  url: 'idb://y', fileName: 'imagined.png',
});
rendering.planRef = plan.id;
rendering.sollJson = { subject: { type: 'door' } };
ws.evidence = [photo, rendering];

const photoBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
await PhotoStorage.put(photo.id, new Blob([photoBytes], { type: 'image/jpeg' }), 'sill.jpg');
await PhotoStorage.put(rendering.id, new Blob([pngBytes], { type: 'image/png' }), 'imagined.png');

// --- binaryEvidence covers both kinds -----------------------------------
{
  const kinds = binaryEvidence(ws).map(e => e.kind).sort();
  assert.deepStrictEqual(kinds, ['photo', 'rendering'], 'renderings count as binary evidence');
  console.log('  ✓ renderings are recognised as carrying bytes');
}

// --- export -------------------------------------------------------------
const { blob, photoCount } = await exportWorkspaceBundle(ws);
assert.strictEqual(photoCount, 2, 'both the photo and the rendering are packed');
console.log('  ✓ export packs photos AND renderings');

// --- inspect the archive ------------------------------------------------
{
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir).sort();
  assert.ok(names.includes('workspace.json'), 'workspace.json present');
  assert.ok(names.some(n => n === `photos/${photo.id}.jpg`), 'photo stored with .jpg extension');
  assert.ok(names.some(n => n === `photos/${rendering.id}.png`), 'rendering stored with .png extension');
  console.log('  ✓ archive layout and extensions follow the blob mime type');
}

// --- import into a clean store -------------------------------------------
{
  PhotoStorage._mem.clear();
  const file = new File([blob], 'Nordportal.zip', { type: 'application/zip' });
  const { workspace: restored, photoCount: restoredCount } = await importWorkspaceBundle(file);

  assert.strictEqual(restoredCount, 2, 'both images are restored to storage');
  assert.strictEqual(restored.instance.name, 'Nordportal', 'artefact name survives');
  assert.strictEqual(restored.plans.length, 1, 'strategy survives');
  assert.strictEqual(restored.plans[0].label, 'Splice and consolidate', 'strategy label survives');
  assert.ok(restored.plans[0].intent, 'strategy keeps its own intent');

  const back = restored.evidence.find(e => e.kind === 'rendering');
  assert.ok(back, 'the rendering record survives');
  assert.strictEqual(back.planRef, plan.id, 'the rendering stays bound to its strategy');
  assert.deepStrictEqual(back.sollJson, { subject: { type: 'door' } }, 'Soll JSON survives');

  const storedRendering = await PhotoStorage.get(rendering.id);
  assert.ok(storedRendering, 'the rendering BLOB is back in storage, not just its record');
  const bytes = new Uint8Array(await storedRendering.blob.arrayBuffer());
  assert.deepStrictEqual(Array.from(bytes), Array.from(pngBytes), 'rendering bytes are byte-identical');

  const storedPhoto = await PhotoStorage.get(photo.id);
  const pbytes = new Uint8Array(await storedPhoto.blob.arrayBuffer());
  assert.deepStrictEqual(Array.from(pbytes), Array.from(photoBytes), 'photo bytes are byte-identical');
  console.log('  ✓ import restores every blob byte-for-byte');
}

// --- a workspace whose only images are renderings must still bundle ------
{
  const renderOnly = newWorkspace();
  const p2 = newPlan({ label: 'Replace' });
  renderOnly.plans = [p2];
  renderOnly.currentPlanId = p2.id;
  const r = newEvidence('rendering', { url: 'idb://z', fileName: 'r.png' });
  renderOnly.evidence = [r];
  await PhotoStorage.put(r.id, new Blob([pngBytes], { type: 'image/png' }), 'r.png');

  assert.strictEqual(binaryEvidence(renderOnly).length, 1, 'a rendering-only workspace has images to pack');
  const out = await exportWorkspaceBundle(renderOnly);
  assert.strictEqual(out.photoCount, 1, 'the rendering is packed even with zero photos');
  console.log('  ✓ a rendering-only workspace still exports its image');
}

// --- plain JSON import still works ---------------------------------------
{
  const jsonFile = new File([JSON.stringify(ws)], 'x.json', { type: 'application/json' });
  const { workspace: fromJson, photoCount: n } = await importWorkspaceBundle(jsonFile);
  assert.strictEqual(n, 0, 'plain JSON reports no photos');
  assert.strictEqual(fromJson.plans.length, 1, 'plain JSON still loads the workspace');
  console.log('  ✓ plain JSON import remains supported for older files');
}

console.log('\n✓ Bundle round trip holds\n');
