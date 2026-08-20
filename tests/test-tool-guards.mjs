/**
 * Tool guards — a tool must never report success for a change it did not make.
 *
 * The client's reducers deliberately return the workspace unchanged when an id
 * does not resolve, so a stale command cannot corrupt state. The cost of that
 * safety is that the tool layer above it used to report success anyway: the
 * model was told "Intent updated (1 axis value)" for an axis that was silently
 * dropped, believed it, and told the participant the axis had been added. The
 * radar never moved. Challenged, the model invented an explanation.
 *
 * A false "done" is worse than an error. An error arrives as a functionResponse
 * that the model can see and correct within the same turn — which is what
 * add_edge already did, and what every tool here now does.
 *
 * Each test asserts BOTH halves: the bad call is refused, and the good call
 * still works. A guard that also blocks legitimate use is not a fix.
 */

import assert from 'node:assert/strict';
import { mapToolToCommand } from '../api/_shared/chat-engine.js';

console.log('\n=== TOOL GUARDS ===');

const WORKSPACE = {
  schemaVersion: '2.1.0',
  currentPlanId: 'plan_1',
  instance: {
    id: 'inst_1',
    name: 'Timber corner',
    parts: [
      { id: 'post_ne', name: 'North-east post', origin: { x: 1, y: 0, z: 2 } },
      { id: 'sill_n', name: 'North sill', origin: { x: 0, y: 0, z: 0 } },
    ],
  },
  conditions: [
    { id: 'cond_rot', type: 'rot', partRef: 'sill_n', status: 'suspected' },
  ],
  plans: [
    {
      id: 'plan_1',
      label: 'Conservative In-Situ Splice',
      steps: [{ id: 'step_a', title: 'Shore the frame' }, { id: 'step_b', title: 'Cut back decay' }],
      edges: [{ id: 'edge_1', source: 'step_a', target: 'step_b' }],
      intent: {
        summary: 'Conserve maximum original fabric.',
        axes: [
          { id: 'axis_1', label: 'Material Authenticity', value: 0.9 },
          { id: 'axis_2', label: 'Structural Performance', value: 0.85 },
        ],
      },
    },
  ],
};

const SNAPSHOT = {
  intent: WORKSPACE.plans[0].intent,
  currentPlan: WORKSPACE.plans[0],
};

const call = (name, args) => mapToolToCommand(name, args, SNAPSHOT, WORKSPACE, [], {});

/** A refusal names the tool, and lists what WOULD have been valid. */
function assertRefused(result, tool, mustMention) {
  assert.ok(result.error, `${tool}: expected a refusal, got ${JSON.stringify(result).slice(0, 160)}`);
  assert.ok(!result.command, `${tool}: a refusal must not still emit a command`);
  assert.ok(!result.ok, `${tool}: a refusal must not report ok`);
  for (const needle of mustMention) {
    assert.ok(
      result.error.includes(needle),
      `${tool}: the refusal should mention "${needle}" so the model can self-correct.\nGot: ${result.error}`,
    );
  }
}

// --- the bug from the workshop screenshot ---------------------------------
{
  const bad = call('set_intent', { summary: 'Now with reversibility.', axes: [{ id: 'reversibility', value: 0.8 }] });
  assertRefused(bad, 'set_intent', ['reversibility', 'axis_1', 'propose_intent_axis']);
  // The summary must NOT sneak through on a refused call — that is what made
  // the original bug so convincing: the prose changed, the radar did not.
  assert.ok(!bad.command, 'a refused set_intent must not apply the summary either');
  console.log('  ✓ set_intent refuses an axis id that does not exist');

  const good = call('set_intent', { axes: [{ id: 'axis_1', value: 0.4 }] });
  assert.equal(good.ok, true);
  assert.equal(good.command.payload.intent.axes.find(a => a.id === 'axis_1').value, 0.4);
  assert.equal(good.command.payload.intent.axes.length, 2, 're-weighting must not drop the other axes');
  console.log('  ✓ set_intent still re-weights an axis that does exist');
}

// --- conditions -----------------------------------------------------------
{
  assertRefused(call('update_condition', { conditionId: 'cond_nope', patch: { status: 'confirmed' } }),
    'update_condition', ['cond_nope', 'cond_rot']);
  console.log('  ✓ update_condition refuses an unknown condition');

  const good = call('update_condition', { conditionId: 'cond_rot', patch: { status: 'confirmed' } });
  assert.equal(good.ok, true);
  console.log('  ✓ update_condition still updates a real condition');

  assertRefused(call('remove_condition', { conditionId: 'cond_nope' }), 'remove_condition', ['cond_rot']);
  assert.equal(call('remove_condition', { conditionId: 'cond_rot' }).ok, true);
  console.log('  ✓ remove_condition refuses an unknown condition, removes a real one');
}

// --- a condition on a part that isn't there -------------------------------
{
  // Not a no-op: the condition IS created, but with null coordinates, and the
  // viewer skips spheres without coordinates. It exists in the list and is
  // invisible in the 3D view — which is where someone surveying will look.
  assertRefused(call('add_condition', { type: 'crack', description: 'x', partRef: 'leg_front_left' }),
    'add_condition', ['leg_front_left', 'post_ne']);
  console.log('  ✓ add_condition refuses a part that is not in the assembly');

  const good = call('add_condition', { type: 'crack', description: 'x', partRef: 'post_ne' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.command.payload.condition.coordinates, { x: 1, y: 0, z: 2 },
    'a real part still anchors the condition to its origin');
  console.log('  ✓ add_condition still places a condition on a real part');
}

// --- plans ----------------------------------------------------------------
{
  // The nastiest of the set. The reducer sets currentPlanId regardless, so a
  // bogus id leaves NO plan current, getCurrentIntent falls back to a fresh
  // default, and the radar snaps back to the seed axes — indistinguishable
  // from the participant's strategy being wiped.
  assertRefused(call('set_active_plan', { planId: 'plan_nope' }), 'set_active_plan', ['plan_nope', 'plan_1']);
  assert.equal(call('set_active_plan', { planId: 'plan_1' }).ok, true);
  console.log('  ✓ set_active_plan refuses an unknown plan (would blank the radar)');

  assertRefused(call('update_plan', { planId: 'plan_nope', patch: { label: 'x' } }), 'update_plan', ['plan_1']);
  assert.equal(call('update_plan', { planId: 'plan_1', patch: { label: 'x' } }).ok, true);
  console.log('  ✓ update_plan refuses an unknown plan');

  assertRefused(call('remove_plan', { planId: 'plan_nope' }), 'remove_plan', ['plan_1']);
  assert.equal(call('remove_plan', { planId: 'plan_1' }).ok, true);
  console.log('  ✓ remove_plan refuses an unknown plan');
}

// --- edges ----------------------------------------------------------------
{
  // remove_edge could never have worked: the tool requires an edgeId, and the
  // snapshot sends edges as {source, target} with the id stripped. Every call
  // was a no-op reported as "1 removed connection".
  const bad = call('remove_edge', { edgeId: 'edge_nope' });
  assertRefused(bad, 'remove_edge', ['step_a', 'step_b']);
  console.log('  ✓ remove_edge refuses an id it cannot have known');
}

// --- the guards must not have broken the tools that were already honest ---
{
  const good = call('set_constraints', { time_budget_minutes: 240 });
  assert.equal(good.ok, true, 'set_constraints was already honest and must still work');

  const edge = call('add_edge', { source: 'step_a', target: 'step_b' });
  assert.equal(edge.ok, true, 'add_edge is the pattern the others now follow');

  const badEdge = call('add_edge', { source: 'step_a', target: 'nope' });
  assert.ok(badEdge.error, 'add_edge already refused unknown steps and still does');
  console.log('  ✓ tools that were already honest are unaffected');
}

console.log('\n✓ No tool reports success for a change it did not make\n');

// --- proposing a criterion, without imposing one --------------------------
//
// The resolution of the tension between "stop asking users to approve AI
// actions" and "values never move without human acceptance": the assistant may
// author the VOCABULARY, only a human authors the WEIGHT. A proposal is inert
// — no weight, no influence — so it needs no approval dialog, and ignoring it
// costs it everything.
{
  const good = call('propose_intent_axis', {
    label: 'Reversibility',
    description: 'How readily the intervention can be undone without damaging original fabric.',
    rationale: 'The conservation manual treats reversibility as a first principle.',
    sourceRefs: ['doc_abc123'],
  });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.command.type, 'add-intent-axis');

  const axis = good.command.payload.axis;
  assert.equal(axis.value, null, 'a proposed axis MUST arrive unweighted — this is the whole mechanism');
  assert.equal(axis.origin, 'assistant', 'provenance records who authored the criterion');
  assert.equal(axis.label, 'Reversibility');
  assert.deepEqual(axis.sourceRefs, ['doc_abc123'], 'the document that motivated it is recorded');
  console.log('  ✓ propose_intent_axis adds an unweighted axis with its provenance');

  // There is no tool that writes a weight. If one ever appears, this fails.
  const setsAWeight = ['set_intent'].some(t => {
    const r = call(t, { axes: [{ id: 'axis_1', value: 0.9 }] });
    return r.ok && r.command?.payload?.intent?.axes?.some(a => a.value === 0.9);
  });
  assert.equal(setsAWeight, true, 'set_intent re-weights EXISTING axes — that is allowed and unchanged');

  // ...but it cannot mint one, which is what keeps proposal and imposition apart.
  const mint = call('set_intent', { axes: [{ id: 'brand_new', value: 0.9 }] });
  assert.ok(mint.error, 'set_intent must not be able to create an axis');
  console.log('  ✓ the assistant can propose a criterion but cannot weight a new one');
}

{
  // A criterion with no stated reason is not something a participant can judge.
  assertRefused(call('propose_intent_axis', { label: 'Reversibility' }),
    'propose_intent_axis', ['rationale']);
  console.log('  ✓ a proposal without a rationale is refused');

  // The model cannot see its own earlier proposals — chat history replays as
  // text without tool calls — so near-duplicates need catching server-side.
  assertRefused(call('propose_intent_axis', { label: 'material authenticity', rationale: 'x' }),
    'propose_intent_axis', ['Material Authenticity', 'axis_1']);
  console.log('  ✓ a near-duplicate of an existing axis is refused');
}

// --- revising the imagined result from chat -------------------------------
//
// The participant objects to what they see; the assistant decides whether that
// is a complaint about the DEPICTION or about the REPAIR, changes the plan if
// it is the latter, and queues a regeneration. The image is not generated
// here: the bytes live in the browser's IndexedDB and generation outlasts this
// endpoint's budget, so the turn carries a request the client fulfils.
{
  const turn = {};
  const withTurn = (name, args) => mapToolToCommand(name, args, SNAPSHOT, WORKSPACE, [], turn);

  const r = withTurn('revise_rendering', {
    instruction: 'The splice should be a stop-splayed scarf, not a butt joint.',
    changesPlan: true,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!r.command, 'a revision emits no workspace command — the client runs the generation');
  assert.equal(turn.renderRequest.instruction, 'The splice should be a stop-splayed scarf, not a butt joint.');
  assert.equal(turn.renderRequest.planId, 'plan_1', 'the revision is bound to the strategy it belongs to');
  console.log('  ✓ revise_rendering queues a regeneration for the client');

  // Queueing several against the same starting image means each ignores the
  // others' changes, and the participant is billed for every one.
  const second = withTurn('revise_rendering', { instruction: 'Also make the pegs square.' });
  assert.ok(second.error, 'a second revision in one turn must be refused');
  assert.match(second.error, /one instruction/);
  console.log('  ✓ only one revision per turn');
}

{
  const turn = {};
  assert.ok(
    mapToolToCommand('revise_rendering', { instruction: '' }, SNAPSHOT, WORKSPACE, [], turn).error,
    'an empty instruction is refused',
  );
  // No active strategy: nothing to imagine a result for.
  const noPlan = { ...WORKSPACE, currentPlanId: null, plans: [] };
  assert.ok(
    mapToolToCommand('revise_rendering', { instruction: 'x' }, { intent: null, currentPlan: null }, noPlan, [], {}).error,
    'without an active strategy the revision is refused',
  );
  console.log('  ✓ revise_rendering refuses an empty instruction and a strategy-less workspace');
}
