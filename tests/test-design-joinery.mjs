import assert from 'node:assert/strict';

import {
  buildJoineryContext,
  validateJointProgram
} from '../api/design-joinery.js';


const workspace = {
  schemaVersion: '2.1.0',
  instance: {
    id: 'frame',
    parts: [
      {
        id: 'rail', label: 'Lower rail', material: 'historic timber',
        origin: { x: 0, y: 0, z: 0 },
        dimensions: { width: 1, height: 0.1, depth: 0.1 },
        rotation: { x: 0, y: 0, z: 0 },
        connections: ['post_a', 'post_b']
      },
      { id: 'post_a', label: 'Post A', connections: ['rail'] },
      { id: 'post_b', label: 'Post B', connections: ['rail'] }
    ]
  },
  conditions: [
    { id: 'rot_rail', type: 'rot', partRef: 'rail', evidenceRefs: ['photo_rail'] }
  ],
  evidence: [
    { id: 'photo_rail', kind: 'photo', url: 'idb://photo', attachedTo: { type: 'condition', id: 'rot_rail' } }
  ],
  plans: [
    {
      id: 'strategy',
      label: 'Structural repair',
      intent: { summary: 'Retain material and restore frame action' },
      constraints: { tools_available: 'hand tools' },
      steps: [
        { id: 'repair_rail', affectedPartRefs: ['rail', 'post_a'], addressesConditionRefs: ['rot_rail'] }
      ]
    }
  ],
  currentPlanId: 'strategy'
};

const context = buildJoineryContext(workspace, 'rail', 'repair_rail');
assert.equal(context.selectedPart.id, 'rail');
assert.deepEqual(context.connectedParts.map(p => p.id), ['post_a', 'post_b']);
assert.equal(context.conditions[0].id, 'rot_rail');
assert.equal(context.strategy.selectedStep.id, 'repair_rail');
assert.equal(context.evidence[0].hasImage, true);
assert.equal('url' in context.evidence[0], false);

const checked = validateJointProgram({
  schema: 'joinery-program@1',
  id: 'joinery_rail_lock',
  targetPartRef: 'rail',
  addressesConditionRefs: ['rot_rail', 'invented_condition'],
  geometry: {
    topology: 'bowtie',
    parameters: { lock_half_width: 0.24 }
  },
  geometryProgram: [
    { operation: 'base_splice', grammar: 'six_plane' },
    { operation: 'intersect_feature', feature: 'bowtie_lock' }
  ],
  fitObjective: {
    mandatoryDamageCoverage: 0.5,
    parameterSamples: 99,
    positionSamples: 7,
    replacementSides: [1, -1]
  },
  affectedPartRefs: ['rail', 'post_a', 'invented_part'],
  confidence: 0.78
}, context, 'repair_rail');

assert.equal(checked.ok, true, checked.errors.join('; '));
assert.equal(checked.program.geometry.topology, 'lapped_bowtie');
assert.equal(checked.program.fitObjective.mandatoryDamageCoverage, 1.0);
assert.equal(checked.program.fitObjective.parameterSamples, 3);
assert.deepEqual(checked.program.addressesConditionRefs, ['rot_rail']);
assert.deepEqual(checked.program.affectedPartRefs, ['rail', 'post_a']);
assert.equal(checked.program.repairStepRef, 'repair_rail');
assert.equal(checked.warnings.length, 2);

console.log('design-joinery contract tests passed');

