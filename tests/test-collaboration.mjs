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
