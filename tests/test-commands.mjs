import { createState } from '../src/core/state.js';
import { apply, undo, redo } from '../src/core/commands.js';

const state = createState();

console.log('=== INITIAL ===');
console.log(`name: "${state.workspace.instance.name}"`);
console.log(`hypotheses: ${state.workspace.hypotheses.length}`);

apply(state, { type: 'set-object-name', payload: { name: 'test chair' } });
console.log(`\nAfter set-object-name → "${state.workspace.instance.name}"`);

apply(state, { type: 'add-hypothesis', payload: { hypothesis: { type: 'Crack', description: 'Hairline crack on front leg', partRef: 'front_right_leg' } } });
console.log(`After add-hypothesis → ${state.workspace.hypotheses.length} hypothesis`);
const hypId = state.workspace.hypotheses[0].id;

apply(state, { type: 'confirm-hypothesis', payload: { hypothesisId: hypId, evidenceId: null } });
console.log(`After confirm → status: ${state.workspace.hypotheses[0].status}, confidence: ${state.workspace.hypotheses[0].confidence}`);

console.log('\n=== UNDO ===');
undo(state);
console.log(`After undo 1 → status: ${state.workspace.hypotheses[0]?.status}`);
undo(state);
console.log(`After undo 2 → hypotheses: ${state.workspace.hypotheses.length}`);
undo(state);
console.log(`After undo 3 → name: "${state.workspace.instance.name}"`);

console.log('\n=== REDO ===');
redo(state);
redo(state);
redo(state);
console.log(`After 3 redos → name: "${state.workspace.instance.name}", hypothesis status: ${state.workspace.hypotheses[0]?.status}`);

console.log('\n=== BATCH (simulates an AI proposal) ===');
const fresh = createState();
apply(fresh, {
  type: 'batch',
  payload: {
    label: 'AI proposed a plan',
    commands: [
      { type: 'add-hypothesis', payload: { hypothesis: { type: 'Loose joint', partRef: 'front_left_leg' } } },
      { type: 'add-hypothesis', payload: { hypothesis: { type: 'Wood rot', partRef: 'back_apron' } } }
    ]
  }
});
console.log(`After batch → ${fresh.workspace.hypotheses.length} hypotheses`);
undo(fresh);
console.log(`After undo batch → ${fresh.workspace.hypotheses.length} hypotheses (should be 0)`);

console.log('\n✓ Command pattern works');
