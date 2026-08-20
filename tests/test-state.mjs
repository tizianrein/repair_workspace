/**
 * Tests for src/core/state.js — persistence, migration-on-restore, quota
 * degradation and participant identity.
 *
 * These paths had no coverage at all, and three of them were losing user data:
 * a schema bump discarded stored work, a full quota failed silently, and the
 * participant name was never persisted so it had to be retyped every reload.
 *
 * Runs against a minimal localStorage stub — no browser needed.
 */

import assert from 'node:assert';

// --- localStorage stub, installed before importing state.js --------------
class MemoryStorage {
  constructor(limitBytes = Infinity) {
    this.map = new Map();
    this.limitBytes = limitBytes;
  }
  get size() {
    let n = 0;
    for (const [k, v] of this.map) n += k.length + v.length;
    return n;
  }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  removeItem(k) { this.map.delete(k); }
  setItem(k, v) {
    const prev = this.map.get(k) ?? '';
    const next = this.size - (this.map.has(k) ? k.length + prev.length : 0) + k.length + v.length;
    if (next > this.limitBytes) {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, v);
  }
}

globalThis.localStorage = new MemoryStorage();

const { createState, persist, restore, autoPersist, saveIdentity, loadIdentity, clearIdentity } =
  await import('../src/core/state.js');
const { newWorkspace, newPlan, newConversation, newMessage, SCHEMA_VERSION } =
  await import('../src/core/schema.js');

console.log('\n=== STATE: PERSISTENCE & IDENTITY ===\n');

function freshState() {
  const s = createState();
  const plan = newPlan({ label: 'Splice and consolidate' });
  s.workspace.plans = [plan];
  s.workspace.currentPlanId = plan.id;
  return s;
}

// --- round trip ----------------------------------------------------------
{
  globalThis.localStorage = new MemoryStorage();
  const s = freshState();
  assert.strictEqual(persist(s).ok, true, 'persist succeeds');
  const s2 = createState();
  assert.strictEqual(restore(s2), true, 'restore succeeds');
  assert.strictEqual(s2.workspace.plans.length, 1, 'plan survives the round trip');
  assert.strictEqual(s2.workspace.plans[0].label, 'Splice and consolidate', 'plan label survives');
  assert.strictEqual(s2.workspace.currentPlanId, s.workspace.currentPlanId, 'currentPlanId survives');
  console.log('  ✓ workspace round-trips through localStorage');
}

// --- migration on restore, not discard -----------------------------------
{
  globalThis.localStorage = new MemoryStorage();
  // A v2.0 workspace: intent/constraints at the root, none on the plan.
  const v20 = {
    ...newWorkspace(),
    schemaVersion: '2.0.0',
    intent: { axes: [{ id: 'axis_1', label: 'Material Authenticity', value: 0.85 }], summary: 'keep fabric' },
    constraints: { time_budget_minutes: 240, skill_level: 'advanced' },
    plans: [],
  };
  localStorage.setItem('repair-workspace-v2', JSON.stringify(v20));

  const s = createState();
  assert.strictEqual(restore(s), true, 'a v2.0 workspace restores instead of being discarded');
  assert.strictEqual(s.workspace.schemaVersion, SCHEMA_VERSION, 'schema version is upgraded');
  assert.ok(s.workspace.plans.length >= 1, 'migration seeds a strategy');
  assert.strictEqual(
    s.workspace.plans[0].intent.axes.find(a => a.id === 'axis_1')?.value,
    0.85,
    'root intent is moved onto the plan, not lost'
  );
  assert.strictEqual(
    s.workspace.plans[0].constraints.time_budget_minutes,
    240,
    'root constraints are moved onto the plan'
  );
  console.log('  ✓ a stale schema version migrates instead of wiping stored work');
}

// --- corrupt / absent storage --------------------------------------------
{
  globalThis.localStorage = new MemoryStorage();
  assert.strictEqual(restore(createState()), false, 'no stored value → false');
  localStorage.setItem('repair-workspace-v2', '{not json');
  assert.strictEqual(restore(createState()), false, 'corrupt JSON → false, no throw');
  console.log('  ✓ missing and corrupt storage are handled without throwing');
}

// --- quota: degrade by trimming transcripts, do not fail silently --------
{
  const s = freshState();
  const thread = newConversation('plan', s.workspace.currentPlanId);
  for (let i = 0; i < 400; i++) {
    thread.messages.push(newMessage(i % 2 ? 'assistant' : 'user', 'x'.repeat(400)));
  }
  s.workspace.conversations = [thread];

  const full = JSON.stringify(s.workspace).length;
  const trimmed = JSON.stringify({
    ...s.workspace,
    conversations: [{ ...thread, messages: thread.messages.slice(-12) }],
  }).length;
  // A budget that rejects the full workspace but accepts the trimmed one.
  globalThis.localStorage = new MemoryStorage(Math.floor((full + trimmed) / 2));

  const result = persist(s);
  assert.strictEqual(result.ok, true, 'quota failure degrades rather than failing');
  assert.strictEqual(result.degraded, 'conversations-trimmed', 'degradation is reported to the caller');
  assert.strictEqual(s.workspace.conversations[0].messages.length, 400, 'the in-memory workspace is NOT trimmed');

  const stored = JSON.parse(localStorage.getItem('repair-workspace-v2'));
  assert.strictEqual(stored.conversations[0].messages.length, 12, 'the stored copy is trimmed');
  assert.strictEqual(stored.plans.length, 1, 'the strategy still survives under pressure');
  console.log('  ✓ a full quota trims transcripts and reports it, keeping strategies');
}

// --- quota: hard failure is reported, never swallowed --------------------
{
  globalThis.localStorage = new MemoryStorage(10); // too small for anything
  const s = freshState();
  const result = persist(s);
  assert.strictEqual(result.ok, false, 'an unrecoverable write reports failure');
  assert.match(result.error, /full/i, 'the error is human-readable');

  const seen = [];
  const s2 = freshState();
  autoPersist(s2, msg => seen.push(msg));
  s2.listeners.forEach(fn => fn(s2.workspace, { type: 'test' }));
  s2.listeners.forEach(fn => fn(s2.workspace, { type: 'test' }));
  assert.strictEqual(seen.length, 1, 'the same failure is reported once, not once per change');
  console.log('  ✓ unrecoverable write failures surface to the UI exactly once');
}

// --- identity survives a reload, scoped per project ----------------------
{
  globalThis.localStorage = new MemoryStorage();
  assert.strictEqual(loadIdentity('proj_a'), null, 'no identity before one is saved');

  saveIdentity('proj_a', { authorName: 'Anna Müller', authorKey: 'anna müller' });
  const back = loadIdentity('proj_a');
  assert.strictEqual(back.authorName, 'Anna Müller', 'name survives, umlaut intact');
  assert.strictEqual(back.authorKey, 'anna müller', 'key survives');

  assert.strictEqual(loadIdentity('proj_b'), null, 'identity does not leak across projects');
  saveIdentity('proj_b', { authorName: 'Tobias', authorKey: 'tobias' });
  assert.strictEqual(loadIdentity('proj_a').authorName, 'Anna Müller', 'projects keep separate identities');

  clearIdentity('proj_a');
  assert.strictEqual(loadIdentity('proj_a'), null, 'identity can be cleared');
  assert.strictEqual(loadIdentity('proj_b').authorName, 'Tobias', 'clearing one leaves the other');

  saveIdentity(null, { authorName: 'x', authorKey: 'x' });
  saveIdentity('proj_c', { authorName: '', authorKey: '' });
  assert.strictEqual(loadIdentity('proj_c'), null, 'empty names are not stored');
  console.log('  ✓ participant identity persists per project and is not exported');
}

// --- identity is not part of the workspace JSON --------------------------
{
  const s = freshState();
  assert.ok(
    !JSON.stringify(s.workspace).includes('authorName'),
    'identity does not ride along inside the workspace object'
  );
  console.log('  ✓ identity is browser-local, not workspace state');
}

console.log('\n✓ State persistence and identity hold\n');
