// Tests for the step-ref resolution that fixes the workshop bug where
// Gemini calls add_edge with a slug like "repair_feet_ends" that doesn't
// match the real step id (e.g. "step_mp9...006") generated server-side.
//
// We test the same mapToolToCommand function the chat engine uses, by
// driving it directly with the public exports. To keep this stand-alone
// and side-effect-free, we re-import the module and exercise it through
// a thin harness that mimics what runChat does — a fresh pendingSteps
// array per "turn", and a workspace snapshot the model would see.

import { strict as assert } from 'node:assert';

// Load the engine. We need a way to call mapToolToCommand. It's not
// exported, so we exercise it through executeTool by faking executeTool
// indirectly: simpler is to require the file as text and eval, but cleaner
// is to just re-export. For the workshop, monkey-patching is fine.

const engineModule = await import('../api/_shared/chat-engine.js');
// We monkey-patch by hijacking runChat's executeTool path. Cleaner: pull
// mapToolToCommand & helpers via dynamic eval. But to keep this minimal
// and not touch the production file's surface API, we replay the engine
// behaviour by hand using a tiny mock harness that mirrors runChat's
// pendingSteps lifecycle.

// Mini-harness: load the source and eval just the helper functions we
// want to test. Reading source as text is the cleanest workshop-day hack.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(__dirname, '..', 'api', '_shared', 'chat-engine.js');
const src = await readFile(sourcePath, 'utf-8');

// Pull out the helpers and mapToolToCommand via a sandboxed eval.
// We strip the imports (they reach for callGeminiWithTools etc which
// we don't need for unit testing) and re-export what we want.
const stripped = src
  .replace(/^import .*?;$/gm, '')
  .replace(/^export /gm, '');
const harness = `${stripped}
return { normalizeSlug, buildStepAliasMap, resolveStepRef, mapToolToCommand };
`;
const factory = new Function(harness);
const { normalizeSlug, buildStepAliasMap, resolveStepRef, mapToolToCommand } = factory();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('normalizeSlug:');
test('lowercases and underscores spaces', () => {
  assert.equal(normalizeSlug('Grundierung auftragen'), 'grundierung_auftragen');
});
test('strips diacritics', () => {
  assert.equal(normalizeSlug('Klarlackschicht für Außen'), 'klarlackschicht_fur_aussen');
});
test('strips leading/trailing punctuation', () => {
  assert.equal(normalizeSlug('-_clean_parts_-'), 'clean_parts');
});
test('handles null/empty', () => {
  assert.equal(normalizeSlug(null), '');
  assert.equal(normalizeSlug(''), '');
});

console.log('\nresolveStepRef:');
test('resolves exact existing step id', () => {
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [{ id: 'clean_parts', title: 'Clean parts' }] }]
  };
  const pending = [];
  const aliases = buildStepAliasMap(ws.plans[0], pending);
  assert.equal(resolveStepRef('clean_parts', aliases), 'clean_parts');
});

test('resolves step by title (case-sensitive exact)', () => {
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [{ id: 'step_abc', title: 'Grundierung auftragen' }] }]
  };
  const aliases = buildStepAliasMap(ws.plans[0], []);
  assert.equal(resolveStepRef('Grundierung auftragen', aliases), 'step_abc');
});

test('resolves step by normalized slug of title', () => {
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [{ id: 'step_abc', title: 'Grundierung auftragen' }] }]
  };
  const aliases = buildStepAliasMap(ws.plans[0], []);
  // Workshop bug case 1: model invents snake_case slug from a title
  assert.equal(resolveStepRef('grundierung_auftragen', aliases), 'step_abc');
});

test('resolves pending step created earlier in this turn by its requested slug', () => {
  const aliases = buildStepAliasMap(null, [
    { realId: 'step_mp9006', requestedSlug: 'repair_feet_ends', title: 'Reparatur der Fußenden' }
  ]);
  assert.equal(resolveStepRef('repair_feet_ends', aliases), 'step_mp9006');
});

test('returns null for unknown refs', () => {
  const aliases = buildStepAliasMap(null, []);
  assert.equal(resolveStepRef('does_not_exist', aliases), null);
});

console.log('\nmapToolToCommand · add_edge:');
test('add_edge succeeds with valid step ids from the live plan', () => {
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [
      { id: 'clean_parts', title: 'Clean' },
      { id: 'prepare_joints', title: 'Prepare joints' }
    ]}]
  };
  const r = mapToolToCommand('add_edge',
    { source: 'clean_parts', target: 'prepare_joints' },
    {}, ws, []
  );
  assert.equal(r.ok, true);
  assert.equal(r.command.type, 'add-edge');
  assert.equal(r.command.payload.source, 'clean_parts');
  assert.equal(r.command.payload.target, 'prepare_joints');
});

test('add_edge resolves by title', () => {
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [
      { id: 'step_a', title: 'Clean parts' },
      { id: 'step_b', title: 'Grundierung auftragen' }
    ]}]
  };
  const r = mapToolToCommand('add_edge',
    { source: 'Clean parts', target: 'Grundierung auftragen' },
    {}, ws, []
  );
  assert.equal(r.ok, true, `Expected ok, got error: ${r.error}`);
  assert.equal(r.command.payload.source, 'step_a');
  assert.equal(r.command.payload.target, 'step_b');
});

test('add_edge resolves by snake_case slug of title', () => {
  // Exact workshop case 2
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [
      { id: 'step_a', title: 'Grundierung auftragen' }
    ]}]
  };
  const r = mapToolToCommand('add_edge',
    { source: 'grundierung_auftragen', target: 'step_a' },
    {}, ws, []
  );
  assert.equal(r.ok, true, `Expected ok, got error: ${r.error}`);
  assert.equal(r.command.payload.source, 'step_a');
});

test('add_edge returns error (NOT command) for unknown step ref', () => {
  // Exact workshop case 1: add_edge with a slug that doesn't exist
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [
      { id: 'clean_parts', title: 'Clean' }
    ]}]
  };
  const r = mapToolToCommand('add_edge',
    { source: 'repair_feet_ends', target: 'clean_parts' },
    {}, ws, []
  );
  assert.ok(r.error, `Expected error, got: ${JSON.stringify(r)}`);
  assert.ok(!r.command, `Expected no command, got: ${JSON.stringify(r.command)}`);
  assert.ok(/repair_feet_ends/.test(r.error), `Error should mention bad ref: ${r.error}`);
});

test('add_edge resolves pending step created earlier in same turn', () => {
  const ws = { currentPlanId: 'plan_1', plans: [{ id: 'plan_1', steps: [{ id: 'clean_parts', title: 'Clean' }] }] };
  const pending = [];
  // Simulate add_step being called first in the turn
  const r1 = mapToolToCommand('add_step',
    { title: 'Reparatur der Fußenden', description: 'fix feet', afterStepId: 'clean_parts' },
    {}, ws, pending
  );
  assert.equal(r1.ok, true);
  const newStepId = r1.stepId;
  // Now model tries to add an edge using the title
  const r2 = mapToolToCommand('add_edge',
    { source: 'Reparatur der Fußenden', target: 'clean_parts' },
    {}, ws, pending
  );
  assert.equal(r2.ok, true, `Expected ok, got error: ${r2.error}`);
  assert.equal(r2.command.payload.source, newStepId);
});

test('add_edge resolves pending step by snake_case slug of its title', () => {
  // Workshop bug exact reproduction: model creates "Reparatur der Fußenden",
  // then references it by "repair_feet_ends" (which is the prompt-side
  // pseudo-id, NOT what the server assigned).
  const ws = { currentPlanId: 'plan_1', plans: [{ id: 'plan_1', steps: [{ id: 'clean_parts', title: 'Clean' }] }] };
  const pending = [];
  const r1 = mapToolToCommand('add_step',
    { title: 'Reparatur der Fußenden', description: 'fix feet' },
    {}, ws, pending
  );
  const newId = r1.stepId;
  // Slug from "Reparatur der Fußenden" → "reparatur_der_fussenden". Not
  // the exact "repair_feet_ends" the model would use, but the model would
  // also see "Reparatur der Fußenden" as the title in the snapshot and
  // can use that. Test that title-derived slug works.
  const r2 = mapToolToCommand('add_edge',
    { source: 'reparatur_der_fussenden', target: 'clean_parts' },
    {}, ws, pending
  );
  assert.equal(r2.ok, true, `Expected ok, got error: ${r2.error}`);
  assert.equal(r2.command.payload.source, newId);
});

console.log('\nmapToolToCommand · add_step with after/before:');
test('add_step with valid afterStepId chains correctly', () => {
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [{ id: 'clean_parts', title: 'Clean' }] }]
  };
  const r = mapToolToCommand('add_step',
    { title: 'Sand', description: 'sand it', afterStepId: 'clean_parts' },
    {}, ws, []
  );
  assert.equal(r.ok, true);
  assert.equal(r.commands.length, 2); // upsert-step + add-edge
  assert.equal(r.commands[1].type, 'add-edge');
  assert.equal(r.commands[1].payload.source, 'clean_parts');
  assert.equal(r.commands[1].payload.target, r.stepId);
});

test('add_step with afterStepId by title still chains', () => {
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [{ id: 'step_abc', title: 'Teile reinigen' }] }]
  };
  const r = mapToolToCommand('add_step',
    { title: 'Sanding', description: 'sand it', afterStepId: 'Teile reinigen' },
    {}, ws, []
  );
  assert.equal(r.ok, true);
  assert.equal(r.commands.length, 2);
  assert.equal(r.commands[1].payload.source, 'step_abc');
});

test('add_step with unknown afterStepId warns but still creates the step', () => {
  const ws = {
    currentPlanId: 'plan_1',
    plans: [{ id: 'plan_1', steps: [{ id: 'clean_parts', title: 'Clean' }] }]
  };
  const r = mapToolToCommand('add_step',
    { title: 'Sand', description: 'sand it', afterStepId: 'never_existed' },
    {}, ws, []
  );
  assert.equal(r.ok, true);
  assert.equal(r.commands.length, 1); // only upsert-step, no broken edge
  assert.ok(r.warnings && r.warnings.length, 'Should have a warning');
});

console.log('\nmapToolToCommand · create_plan:');
test('create_plan resolves internal edges between its own steps', () => {
  const ws = { currentPlanId: null, plans: [] };
  const r = mapToolToCommand('create_plan', {
    label: 'Test',
    steps: [
      { id: 'clean', title: 'Clean', description: 'a' },
      { id: 'sand', title: 'Sand', description: 'b' }
    ],
    edges: [{ source: 'clean', target: 'sand' }]
  }, {}, ws, []);
  assert.equal(r.ok, true);
  const plan = r.command.payload.plan;
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.edges.length, 1);
  // Important: source/target in the saved edge are the real step ids, not
  // the model's id strings.
  assert.equal(plan.edges[0].source, plan.steps[0].id);
  assert.equal(plan.edges[0].target, plan.steps[1].id);
});

test('create_plan silently drops edges to nonexistent steps', () => {
  const ws = { currentPlanId: null, plans: [] };
  const r = mapToolToCommand('create_plan', {
    label: 'Test',
    steps: [{ id: 'clean', title: 'Clean', description: 'a' }],
    edges: [
      { source: 'clean', target: 'sand_that_does_not_exist' },
      { source: 'clean', target: 'clean' } // self-loop, but step exists
    ]
  }, {}, ws, []);
  assert.equal(r.ok, true);
  // One edge dropped, one kept (self-loop is up to add-edge command to reject)
  assert.equal(r.command.payload.plan.edges.length, 1);
  assert.ok(r.droppedEdges, 'Should report dropped edges');
});

console.log('\nturnContext.pendingPlanId (image-1 bug):');
test('create_plan sets pendingPlanId so subsequent add_step targets the new plan', () => {
  // The exact image-1 scenario: workspace has an old current plan, model
  // creates a NEW plan in the same turn, then adds steps. Without the
  // turnContext fix the add_step routed to the OLD plan.
  const ws = {
    currentPlanId: 'plan_OLD',
    plans: [{ id: 'plan_OLD', steps: [{ id: 'old_step', title: 'Old step' }] }]
  };
  const pending = [];
  const turnContext = { pendingPlanId: null };
  const r1 = mapToolToCommand('create_plan',
    { label: 'New strategy', steps: [{ id: 'first', title: 'First', description: 'a' }] },
    {}, ws, pending, turnContext
  );
  assert.equal(r1.ok, true);
  const newPlanId = r1.planId;
  // Important: turnContext was updated by create_plan
  assert.equal(turnContext.pendingPlanId, newPlanId, 'turnContext should hold the new plan id');

  // Now add_step in the SAME turn should target the new plan, not the old one
  const r2 = mapToolToCommand('add_step',
    { title: 'Second', description: 'b' },
    {}, ws, pending, turnContext
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.commands[0].payload.planId, newPlanId,
    `add_step should target new plan (${newPlanId}), not old (plan_OLD)`);
});

test('add_step without any active plan returns error', () => {
  const ws = { currentPlanId: null, plans: [] };
  const r = mapToolToCommand('add_step',
    { title: 'Step', description: 'a' },
    {}, ws, [], { pendingPlanId: null }
  );
  assert.ok(r.error, 'Should error when no plan is active');
});

test('add_step with afterStepId can reference step in pending plan from same turn', () => {
  const ws = { currentPlanId: null, plans: [] };
  const pending = [];
  const turnContext = { pendingPlanId: null };
  // create_plan in same turn with one step
  const r1 = mapToolToCommand('create_plan',
    { label: 'Plan', steps: [{ id: 'clean', title: 'Clean', description: 'a' }] },
    {}, ws, pending, turnContext
  );
  // Now simulate that the new plan has been "materialized" in fullWorkspace
  // (this is what client-side state will eventually do, but for the alias
  // map's purposes, we also have the plan in pending tracking)
  const wsWithNewPlan = {
    currentPlanId: 'plan_OLD',  // workspace currentPlan still stale
    plans: [
      { id: turnContext.pendingPlanId, steps: r1.command.payload.plan.steps }
    ]
  };
  // add_step into the new plan, using afterStepId
  const r2 = mapToolToCommand('add_step',
    { title: 'Second', description: 'b', afterStepId: 'clean' },
    {}, wsWithNewPlan, pending, turnContext
  );
  assert.equal(r2.ok, true, `Expected ok, got: ${r2.error}`);
  assert.equal(r2.commands.length, 2, 'should produce upsert-step + add-edge');
  assert.equal(r2.commands[1].type, 'add-edge');
});

test('set_active_plan updates turnContext', () => {
  const ws = {
    currentPlanId: 'plan_A',
    plans: [
      { id: 'plan_A', steps: [] },
      { id: 'plan_B', steps: [{ id: 'b_step', title: 'B Step' }] }
    ]
  };
  const turnContext = { pendingPlanId: null };
  const r1 = mapToolToCommand('set_active_plan',
    { planId: 'plan_B' }, {}, ws, [], turnContext
  );
  assert.equal(r1.ok, true);
  assert.equal(turnContext.pendingPlanId, 'plan_B');
  // Now an add_edge should resolve refs in plan_B's step list
  const r2 = mapToolToCommand('add_edge',
    { source: 'b_step', target: 'b_step' },  // bogus but tests resolution
    {}, ws, [], turnContext
  );
  assert.equal(r2.ok, true, `Expected ok, got: ${r2.error}`);
  assert.equal(r2.command.payload.planId, 'plan_B');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
