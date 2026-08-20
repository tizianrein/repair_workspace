import assert from 'node:assert/strict';
import {
  indexRepairProposals,
  proposalSummary,
  repairProposals,
  stepProposalEntries,
} from '../src/core/repair-proposals.js';

const proposal = {
  id: 'proposal_1',
  candidateId: 'candidate_1',
  partRefs: ['post'],
  actionRefs: ['cut'],
  candidate: { manifest: { title: 'Bridled repair' } },
  facts: {
    facts: [
      { id: 'geometry.output_count', status: 'measured', value: 2 },
      { id: 'assembly.insertion', status: 'unknown' },
    ],
  },
  requirements: {
    compliance: [
      { id: 'keep_access', evaluation: { status: 'satisfied' } },
      { id: 'verify_fit', evaluation: { status: 'unknown' } },
    ],
  },
  decision: { decision: 'accept', rationale: 'Continue with a physical mock-up.' },
  geometryArtifact: {
    schema: 'repair-geometry-artifact@1',
    path: 'repair_geometry/candidate_1.3dm',
    format: '3dm',
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    geometryHash: 'geometry_1',
    entityCount: 2,
  },
};

const workspace = {
  repairGeometryProposals: [proposal],
  plans: [{
    id: 'plan_a',
    label: 'Conservative splice',
    steps: [{
      id: 'cut',
      title: 'Cut repair joint',
      repairGeometryProposalRefs: ['proposal_1', 'missing_1', 'proposal_1'],
    }],
  }],
};

assert.equal(repairProposals(workspace).length, 1);

const index = indexRepairProposals(workspace);
assert.equal(index.byId.get('proposal_1'), proposal);
assert.deepEqual(index.linksByProposalId.get('proposal_1'), [{
  planId: 'plan_a',
  planLabel: 'Conservative splice',
  stepId: 'cut',
  stepTitle: 'Cut repair joint',
}]);

const stepEntries = stepProposalEntries(workspace, workspace.plans[0].steps[0]);
assert.deepEqual(stepEntries.map(item => item.id), ['proposal_1', 'missing_1']);
assert.equal(stepEntries[0].proposal, proposal);
assert.equal(stepEntries[1].proposal, null);

const summary = proposalSummary(proposal, index.linksByProposalId.get('proposal_1'));
assert.equal(summary.title, 'Bridled repair');
assert.equal(summary.decision, 'accept');
assert.deepEqual(summary.factCounts, { measured: 1, unknown: 1 });
assert.deepEqual(summary.complianceCounts, { satisfied: 1, unknown: 1 });
assert.equal(summary.links[0].stepId, 'cut');
assert.deepEqual(summary.geometryArtifact, {
  path: 'repair_geometry/candidate_1.3dm',
  format: '3dm',
  entityCount: 2,
  sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  shortHash: '0123456789ab…',
});

const legacySummary = proposalSummary({ id: 'legacy', decision: 'undecided' });
assert.equal(legacySummary.geometryArtifact, null);

assert.deepEqual(repairProposals({ repairGeometryProposals: 'bad data' }), []);

console.log('repair proposal reader tests passed');
