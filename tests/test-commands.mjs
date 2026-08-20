import assert from 'node:assert/strict';
import { createState } from '../src/core/state.js';
import { newWorkspace, newPlan, newStep } from '../src/core/schema.js';
import { apply, undo, redo } from '../src/core/commands.js';

const state = createState();

console.log('=== INITIAL ===');
console.log(`name: "${state.workspace.instance.name}"`);
console.log(`conditions: ${state.workspace.conditions.length}`);

apply(state, { type: 'set-object-name', payload: { name: 'test chair' } });
console.log(`\nAfter set-object-name → "${state.workspace.instance.name}"`);

apply(state, { type: 'add-condition', payload: { condition: { type: 'Crack', description: 'Hairline crack on front leg', partRef: 'front_right_leg' } } });
console.log(`After add-condition → ${state.workspace.conditions.length} condition`);
const hypId = state.workspace.conditions[0].id;

apply(state, { type: 'confirm-condition', payload: { conditionId: hypId, evidenceId: null } });
console.log(`After confirm → status: ${state.workspace.conditions[0].status}, confidence: ${state.workspace.conditions[0].confidence}`);

console.log('\n=== UNDO ===');
undo(state);
console.log(`After undo 1 → status: ${state.workspace.conditions[0]?.status}`);
undo(state);
console.log(`After undo 2 → conditions: ${state.workspace.conditions.length}`);
undo(state);
console.log(`After undo 3 → name: "${state.workspace.instance.name}"`);

console.log('\n=== REDO ===');
redo(state);
redo(state);
redo(state);
console.log(`After 3 redos → name: "${state.workspace.instance.name}", condition status: ${state.workspace.conditions[0]?.status}`);

console.log('\n=== BATCH (simulates an AI proposal) ===');
const fresh = createState();
apply(fresh, {
  type: 'batch',
  payload: {
    label: 'AI proposed a plan',
    commands: [
      { type: 'add-condition', payload: { condition: { type: 'Loose joint', partRef: 'front_left_leg' } } },
      { type: 'add-condition', payload: { condition: { type: 'Wood rot', partRef: 'back_apron' } } }
    ]
  }
});
console.log(`After batch → ${fresh.workspace.conditions.length} conditions`);
undo(fresh);
console.log(`After undo batch → ${fresh.workspace.conditions.length} conditions (should be 0)`);

console.log('\n✓ Command pattern works');

// --- forking must actually isolate -----------------------------------------
//
// newStep() passes every non-scalar field through by reference, so a forked
// strategy shared justification, affectedPartRefs, toolsRequired and
// joineryProposal with the strategy it came from. Editing the fork edited the
// original. Forking is the divergence mechanism and justification is where
// divergence is recorded, so the two strategies that are supposed to differ
// were writing to one shared rationale.
{
  const plan = newPlan({ label: 'Original' });
  const step = newStep({ title: 'Splice the sill' });
  step.justification.drivingIntentAxes = ['axis_1'];
  step.affectedPartRefs = ['sill_n'];
  step.toolsRequired = ['chisel'];
  plan.steps = [step];

  const ws = newWorkspace();
  ws.plans = [plan];
  ws.currentPlanId = plan.id;
  const state = { workspace: ws, history: [], future: [], listeners: [] };

  apply(state, { type: 'duplicate-plan', payload: { sourcePlanId: plan.id, label: 'Fork' } });
  const src = state.workspace.plans[0].steps[0];
  const dup = state.workspace.plans[1].steps[0];

  assert.notEqual(src.justification, dup.justification, 'a fork must not share the justification object');
  assert.notEqual(src.affectedPartRefs, dup.affectedPartRefs, 'a fork must not share affectedPartRefs');
  assert.notEqual(src.toolsRequired, dup.toolsRequired, 'a fork must not share toolsRequired');

  dup.justification.drivingIntentAxes.push('axis_leaked');
  dup.affectedPartRefs.push('post_leaked');
  assert.deepEqual(src.justification.drivingIntentAxes, ['axis_1'], 'editing the fork must not touch the original');
  assert.deepEqual(src.affectedPartRefs, ['sill_n'], 'editing the fork must not touch the original');
  console.log('✓ forking a strategy isolates its steps from the original');
}
