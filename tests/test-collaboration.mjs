import assert from 'node:assert/strict';
import {
  conditionLayerSnapshot,
  createProjectId,
  exampleProjectId,
  mergeConditionLayer,
  normalizeAuthorKey as normalizeClientAuthorKey,
  projectTemplate,
} from '../src/core/collaboration.js';
import {
  isValidEvidenceId,
  isValidProjectId,
  normalizeAuthorKey as normalizeWorkerAuthorKey,
  normalizeAuthorName,
  isOriginAllowed,
} from '../cloudflare/worker.js';

console.log('=== COLLABORATION HELPERS ===');

assert.equal(normalizeClientAuthorKey('  Tizian  Müller '), 'tizian müller');
assert.equal(normalizeWorkerAuthorKey('  Tizian  Müller '), 'tizian müller');
assert.equal(normalizeAuthorName('  Tizian   Müller '), 'Tizian Müller');

const generated = createProjectId();
assert.match(generated, /^proj_[a-f0-9]{20}$/);
assert.equal(isValidProjectId(generated), true);
assert.equal(exampleProjectId('chapel foot'), 'example:chapel_foot');
assert.equal(isValidProjectId('example:chapel_foot'), true);
assert.equal(isValidProjectId('../unsafe'), false);
assert.equal(isValidEvidenceId('ev_photo_123'), true);
assert.equal(isValidEvidenceId('../photo'), false);

const source = {
  schemaVersion: '2.1.0',
  instance: { id: 'inst_1', name: 'Chair', parts: [] },
  conditions: [{ id: 'cond_1', type: 'crack' }],
  evidence: [
    { id: 'ev_part', kind: 'note', attachedTo: { type: 'part', id: 'leg' } },
    { id: 'ev_cond', kind: 'photo', attachedTo: { type: 'condition', id: 'cond_1' } },
  ],
  plans: [],
};
const template = projectTemplate(source, generated);
assert.deepEqual(template.conditions, []);
assert.deepEqual(template.evidence.map(item => item.id), ['ev_part']);
assert.equal(template.collaboration.projectId, generated);
assert.equal(source.conditions.length, 1, 'source workspace must stay unchanged');

const sharedWorkspace = {
  ...source,
  evidence: [
    { id: 'ev_base', kind: 'photo', attachedTo: { type: 'part', id: 'leg' } },
    {
      id: 'ev_photo',
      kind: 'photo',
      attachedTo: { type: 'condition', id: 'cond_1' },
      url: 'cloud://project/ev_photo',
      fileName: 'crack.jpg',
      byteSize: 1234,
      mimeType: 'image/jpeg',
    },
  ],
};
const snapshot = conditionLayerSnapshot(sharedWorkspace, ' Tizian ');
assert.equal(snapshot[0].authorName, 'Tizian');
assert.equal(snapshot[0].evidenceRecords.length, 1);
assert.equal(snapshot[0].evidenceRecords[0].id, 'ev_photo');

const merged = mergeConditionLayer(
  { ...sharedWorkspace, conditions: [], evidence: [sharedWorkspace.evidence[0]] },
  snapshot,
);
assert.equal(merged.conditions[0].evidenceRecords, undefined);
assert.deepEqual(merged.evidence.map(item => item.id), ['ev_base', 'ev_photo']);

console.log('✓ Collaboration helpers work');

// --- CORS origin matching ---------------------------------------------------
//
// A rejected origin is not a visible error: the browser blocks the response,
// the client falls back to offline mode, and ten participants quietly stop
// collaborating. Worth pinning down exactly.

const ALLOWED = [
  'http://localhost:5173',
  'https://repair-workspace.vercel.app',
  'https://repair-workspace-*-tizian-reins-projects.vercel.app',
];

assert.equal(isOriginAllowed('https://repair-workspace.vercel.app', ALLOWED), true, 'production');
assert.equal(isOriginAllowed('http://localhost:5173', ALLOWED), true, 'local dev');
assert.equal(
  isOriginAllowed('https://repair-workspace-9f3ka2x-tizian-reins-projects.vercel.app', ALLOWED),
  true,
  'a preview deployment',
);
assert.equal(isOriginAllowed('https://evil.example.com', ALLOWED), false, 'unrelated origin');
// The wildcard must not cross a dot, or any host under any domain could
// suffix-match its way in.
assert.equal(
  isOriginAllowed('https://repair-workspace-x.evil.com-tizian-reins-projects.vercel.app', ALLOWED),
  false,
  'wildcard must not span dots',
);
assert.equal(
  isOriginAllowed('http://localhost:5174', ALLOWED),
  false,
  'a different port is a different origin',
);
assert.equal(isOriginAllowed('https://anything.at.all', ['*']), true, 'explicit allow-all still works');

console.log('✓ CORS origin matching holds');
