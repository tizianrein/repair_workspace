import { createState } from '../src/core/state.js';
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
