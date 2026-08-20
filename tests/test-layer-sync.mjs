/**
 * Layer sync tests.
 *
 * The behaviours here are the ones whose absence cost data in the previous
 * design: strategies never leaving the browser, a failed save looking exactly
 * like a successful one, two tabs silently overwriting each other, and a
 * pending debounce dying when a phone was pocketed.
 */

import assert from 'node:assert';
import { createLayerSync, layerSnapshot, applyLayer, SYNC_STATE } from '../src/core/layer-sync.js';
import { newWorkspace, newPlan, newCondition, newEvidence, newPart, newConversation, newMessage }
  from '../src/core/schema.js';

console.log('\n=== LAYER SYNC ===\n');

function makeWorkspace() {
  const ws = newWorkspace();
  ws.instance.name = 'Türsturz';
  ws.instance.parts = [newPart('sill'), newPart('post')];
  const plan = newPlan({ label: 'Splice and consolidate' });
  plan.intent.axes[0].value = 0.9;
  ws.plans = [plan];
  ws.currentPlanId = plan.id;
  ws.conditions = [newCondition({ description: 'rot', partRef: 'sill' })];
  ws.evidence = [newEvidence('photo', { attachedTo: { type: 'condition', id: ws.conditions[0].id } })];
  const thread = newConversation('plan', plan.id);
  thread.messages = [newMessage('user', 'hello')];
  ws.conversations = [thread];
  ws.executionLog = [{ id: 'exec_1', stepRef: 'step_1' }];
  return ws;
}

// --- the snapshot carries everything that was previously stranded ---------
{
  const ws = makeWorkspace();
  const snap = layerSnapshot(ws, { authorName: 'Anna Müller', authorKey: 'anna müller' });

  assert.strictEqual(snap.plans.length, 1, 'strategies are in the snapshot');
  assert.strictEqual(snap.plans[0].intent.axes[0].value, 0.9, 'per-strategy intent travels');
  assert.strictEqual(snap.instance.parts.length, 2, 'the parts model is in the layer, not the project');
  assert.strictEqual(snap.conversations.length, 1, 'conversations travel');
  assert.strictEqual(snap.executionLog.length, 1, 'execution log travels');
  assert.strictEqual(snap.conditions[0].authorName, 'Anna Müller', 'conditions are stamped with the author');
  console.log('  ✓ snapshot carries parts, strategies, conversations and execution log');
}

// --- round trip -----------------------------------------------------------
{
  const ws = makeWorkspace();
  const snap = layerSnapshot(ws, { authorName: 'Anna', authorKey: 'anna' });
  const restored = applyLayer(newWorkspace(), JSON.parse(JSON.stringify(snap)));

  assert.strictEqual(restored.plans.length, 1, 'strategy restored');
  assert.strictEqual(restored.plans[0].label, 'Splice and consolidate', 'label restored');
  assert.strictEqual(restored.currentPlanId, ws.currentPlanId, 'current strategy restored');
  assert.strictEqual(restored.instance.parts.length, 2, 'parts restored');
  assert.strictEqual(restored.conditions.length, 1, 'conditions restored');
  console.log('  ✓ a layer round-trips without loss');
}

// --- a participant with no layer keeps the project seed artefact ----------
{
  const seeded = newWorkspace();
  seeded.instance.parts = [newPart('sill'), newPart('post'), newPart('brace')];
  const fresh = applyLayer(seeded, { conditions: [], evidence: [], executionLog: [] });
  assert.strictEqual(fresh.instance.parts.length, 3, 'seed artefact survives an empty layer');
  assert.strictEqual(fresh.conditions.length, 0, 'the survey starts empty');
  console.log('  ✓ a new participant inherits the seed artefact, not an empty one');
}

// --- harness --------------------------------------------------------------
function harness({ putLayer }) {
  const states = [];
  const ws = makeWorkspace();
  const ctx = { projectId: 'proj_x', authorName: 'Anna', authorKey: 'anna', readOnly: false };
  const sync = createLayerSync({
    api: { putLayer },
    getWorkspace: () => ws,
    getContext: () => ctx,
    onState: (s) => states.push(s),
    log: () => {},
  });
  return { sync, states, ctx, ws };
}

// --- a write is based on the revision that was read -----------------------
{
  const seen = [];
  const { sync } = harness({
    putLayer: async (_p, _a, body) => { seen.push(body.baseRev); return { rev: (body.baseRev || 0) + 1 }; },
  });
  sync.setRevision(7);
  await sync.flush({ force: true });
  assert.deepStrictEqual(seen, [7], 'the write declares the revision it was based on');
  assert.strictEqual(sync.getRevision(), 8, 'the revision advances with the server');
  await sync.flush({ force: true });
  assert.deepStrictEqual(seen, [7, 8], 'the next write uses the new revision');
  console.log('  ✓ revisions are tracked across writes');
}

// --- a conflict is surfaced, never silently resolved ----------------------
{
  const { sync, states } = harness({
    putLayer: async () => { const e = new Error('Layer changed elsewhere'); e.status = 409; throw e; },
  });
  sync.setRevision(3);
  const result = await sync.flush({ force: true });
  assert.strictEqual(result.conflict, true, 'a 409 is reported as a conflict');
  assert.ok(states.includes(SYNC_STATE.CONFLICT), 'the UI is told');
  assert.strictEqual(sync.isDirty(), true, 'the work stays dirty — nothing is thrown away');
  assert.strictEqual(sync.getRevision(), 3, 'the revision is NOT advanced past a rejected write');
  console.log('  ✓ a concurrent write conflicts loudly and keeps the local work');
}

// --- a conflict can actually be recovered from -----------------------------
//
// The UI offers "overwrite" after a conflict. It has to be reachable: an
// ordinary save carries the same stale baseRev, so retrying conflicts again
// and the participant would spend the rest of the session unable to reach the
// server without knowing it.
{
  const seen = [];
  let failNext = true;
  const { sync, states } = harness({
    putLayer: async (_p, _a, body) => {
      // Inspect the serialised form, because that is what the Worker parses:
      // JSON.stringify drops an undefined value, and a dropped key is exactly
      // the difference between "replace whatever is there" and "I expect
      // revision 0".
      const wire = JSON.parse(JSON.stringify(body));
      seen.push('baseRev' in wire ? wire.baseRev : '(omitted)');
      if (failNext) { failNext = false; const e = new Error('changed'); e.status = 409; throw e; }
      return { rev: 9 };
    },
  });
  sync.setRevision(4);

  const conflicted = await sync.flush({ force: true });
  assert.strictEqual(conflicted.conflict, true);

  // Retrying the ordinary way must NOT be what resolves it — that would make
  // overwriting an accident of the debounce timer rather than a decision.
  const overwritten = await sync.overwriteRemote();
  assert.strictEqual(overwritten.ok, true, 'a deliberate overwrite succeeds');
  assert.deepStrictEqual(seen, [4, '(omitted)'],
    'the overwrite omits baseRev entirely; null would be read as revision 0');
  assert.strictEqual(sync.getRevision(), 9, 'the revision resyncs to the server');
  assert.strictEqual(sync.isDirty(), false, 'the work is no longer pending');
  assert.strictEqual(states.at(-1), SYNC_STATE.IDLE, 'the UI leaves the conflict state');
  console.log('  ✓ a conflict is recoverable by a deliberate overwrite');
}

// --- a network failure retries and stays dirty ----------------------------
{
  let calls = 0;
  const { sync, states } = harness({
    putLayer: async () => { calls += 1; throw new Error('network down'); },
  });
  const result = await sync.flush({ force: true });
  assert.strictEqual(result.ok, false, 'failure is reported to the caller');
  assert.ok(states.includes(SYNC_STATE.OFFLINE), 'the UI shows offline, not saved');
  assert.strictEqual(sync.isDirty(), true, 'still dirty, so a retry will pick it up');
  assert.strictEqual(calls, 1, 'one attempt made synchronously');
  console.log('  ✓ a failed save reports failure and keeps the work pending');
}

// --- read-only and unnamed participants never write ----------------------
{
  let calls = 0;
  const { sync, ctx } = harness({ putLayer: async () => { calls += 1; return { rev: 1 }; } });

  ctx.readOnly = true;
  await sync.flush({ force: true });
  assert.strictEqual(calls, 0, 'read-only ("All conditions") never writes back');

  ctx.readOnly = false;
  ctx.authorName = '';
  await sync.flush({ force: true });
  assert.strictEqual(calls, 0, 'an unnamed participant never writes');

  ctx.authorName = 'Anna';
  await sync.flush({ force: true });
  assert.strictEqual(calls, 1, 'a named, writable participant does write');
  console.log('  ✓ read-only and unnamed states never write to the server');
}

// --- suspend blocks the echo while a layer is being applied ---------------
{
  let calls = 0;
  const { sync } = harness({ putLayer: async () => { calls += 1; return { rev: 1 }; } });
  sync.suspend();
  await sync.flush({ force: true });
  assert.strictEqual(calls, 0, 'suspended: a bulk load does not echo straight back');
  sync.resume();
  await sync.flush({ force: true });
  assert.strictEqual(calls, 1, 'resumed: writes flow again');
  console.log('  ✓ suspend prevents a loaded layer echoing back to the server');
}

// --- one in-flight write at a time ---------------------------------------
{
  let active = 0, maxActive = 0;
  const { sync } = harness({
    putLayer: async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 20));
      active -= 1;
      return { rev: 1 };
    },
  });
  await Promise.all([sync.flush({ force: true }), sync.flush({ force: true }), sync.flush({ force: true })]);
  assert.strictEqual(maxActive, 1, 'concurrent flushes coalesce into one request');
  console.log('  ✓ concurrent flushes coalesce, so writes cannot race each other');
}

console.log('\n✓ Layer sync holds\n');
