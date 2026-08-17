import assert from 'node:assert/strict';
import { newCondition, newPart, newWorkspace } from '../src/core/schema.js';

const apiRoot = process.env.COLLAB_API_URL || 'http://127.0.0.1:8787/api/collaboration';
const projectId = 'integration:shared_conditions';
const projectUrl = `${apiRoot}/projects/${encodeURIComponent(projectId)}`;
const headers = { Origin: 'http://localhost:5173' };

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const preflight = await fetch(`${apiRoot}/projects/integration:shared_conditions/evidence/ev_preflight`, {
  method: 'OPTIONS',
  headers: { ...headers, 'Access-Control-Request-Method': 'GET' },
});
assert.equal(preflight.status, 204);
assert.match(preflight.headers.get('access-control-allow-methods') || '', /PUT/);
assert.match(preflight.headers.get('access-control-allow-headers') || '', /X-File-Name/i);

const health = await jsonRequest(`${apiRoot}/health`);
assert.equal(health.ok, true);

const workspace = newWorkspace();
workspace.instance.name = 'Shared test object';
workspace.instance.parts = [newPart('part_1', { label: 'Door' })];
workspace.conditions = [{
  ...newCondition({ type: 'crack', partRef: 'part_1' }),
  id: 'must_be_removed_from_template',
}];

const savedProject = await jsonRequest(projectUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Shared test object', baseWorkspace: workspace, sourceType: 'test' }),
});
assert.equal(savedProject.project.id, projectId);
assert.deepEqual(savedProject.project.baseWorkspace.conditions, []);

for (const [authorName, id, type] of [
  ['Tizian', 'condition_tizian', 'crack'],
  ['Anna', 'condition_anna', 'corrosion'],
]) {
  const condition = { ...newCondition({ type, partRef: 'part_1' }), id };
  const saved = await jsonRequest(`${projectUrl}/conditions?author=${encodeURIComponent(authorName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorName, conditions: [condition] }),
  });
  assert.equal(saved.saved, 1);
}

const mine = await jsonRequest(`${projectUrl}/conditions?author=tizian`);
assert.equal(mine.conditions.length, 1);
assert.equal(mine.conditions[0].authorName, 'Tizian');

const all = await jsonRequest(`${projectUrl}/conditions`);
assert.equal(all.conditions.length, 2);
assert.deepEqual(new Set(all.conditions.map(item => item.authorName)), new Set(['Anna', 'Tizian']));

const authors = await jsonRequest(`${projectUrl}/authors`);
assert.equal(authors.authors.length, 2);

const evidenceId = 'ev_shared_photo';
const photoBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const photoSaved = await jsonRequest(`${projectUrl}/evidence/${evidenceId}`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'image/jpeg',
    'X-File-Name': encodeURIComponent('condition photo.jpg'),
    'X-Author-Name': encodeURIComponent('Tizian'),
  },
  body: photoBytes,
});
assert.equal(photoSaved.evidenceId, evidenceId);

const photo = await fetch(`${projectUrl}/evidence/${evidenceId}`, { headers });
assert.equal(photo.ok, true);
assert.equal(photo.headers.get('content-type'), 'image/jpeg');
assert.equal(decodeURIComponent(photo.headers.get('x-file-name')), 'condition photo.jpg');
assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), photoBytes);

const modelBytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
const modelSaved = await jsonRequest(`${projectUrl}/model`, {
  method: 'PUT',
  headers: { 'Content-Type': 'model/gltf-binary' },
  body: modelBytes,
});
assert.equal(modelSaved.ok, true);

const model = await fetch(`${projectUrl}/model`, { headers });
assert.equal(model.ok, true);
assert.deepEqual(new Uint8Array(await model.arrayBuffer()), modelBytes);

console.log('✓ Cloudflare Worker, D1 snapshots, CORS, and R2 model/photo storage work');
