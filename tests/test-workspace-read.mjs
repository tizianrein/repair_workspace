/**
 * Regression test for the v2.1 intent/constraints location.
 *
 * Schema 2.1 moved `intent` and `constraints` off the workspace root onto
 * each plan. Four endpoints kept reading the root and silently received
 * `undefined` on every real workspace, which meant the planner ran with an
 * empty primary directive. This test pins the contract so that regression
 * cannot recur silently.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIntent, getConstraints, getCurrentPlan, isIntentNeutral } from '../api/_shared/workspace-read.js';
import { newWorkspace, newPlan, newIntent, newConstraints } from '../src/core/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

console.log('\n=== WORKSPACE READ (v2.1 intent location) ===\n');

// --- a real v2.1 workspace: intent lives on the plan --------------------
const ws = newWorkspace();
const plan = newPlan({ label: 'Splice and consolidate' });
plan.intent.axes[0].value = 0.9;          // Material Authenticity
plan.intent.summary = 'Keep original fabric wherever it still carries load.';
plan.constraints.time_budget_minutes = 240;
ws.plans = [plan];
ws.currentPlanId = plan.id;

assert.strictEqual(getCurrentPlan(ws)?.id, plan.id, 'current plan resolves');
assert.strictEqual(getIntent(ws).axes[0].value, 0.9, 'intent read from the current plan');
assert.strictEqual(
  getIntent(ws).summary,
  'Keep original fabric wherever it still carries load.',
  'intent summary read from the current plan'
);
assert.strictEqual(getConstraints(ws).time_budget_minutes, 240, 'constraints read from the current plan');
console.log('  ✓ intent + constraints read from the current plan');

// --- two strategies must not bleed into each other ----------------------
const planB = newPlan({ label: 'Full replacement' });
planB.intent.axes[0].value = 0.1;
ws.plans.push(planB);
ws.currentPlanId = planB.id;
assert.strictEqual(getIntent(ws).axes[0].value, 0.1, 'switching strategy switches intent');
ws.currentPlanId = plan.id;
assert.strictEqual(getIntent(ws).axes[0].value, 0.9, 'switching back restores the first intent');
console.log('  ✓ intent is per-strategy, no bleed between plans');

// --- pre-2.1 / pre-slimmed payloads still work --------------------------
const legacy = { intent: newIntent(), constraints: newConstraints(), plans: [] };
legacy.intent.summary = 'legacy root intent';
assert.strictEqual(getIntent(legacy).summary, 'legacy root intent', 'root fallback for legacy payloads');
console.log('  ✓ root fallback for legacy / pre-slimmed payloads');

// --- never undefined ----------------------------------------------------
assert.ok(getIntent(null), 'getIntent(null) returns an object');
assert.ok(Array.isArray(getIntent({}).axes), 'getIntent({}) has an axes array');
assert.ok(getConstraints(undefined), 'getConstraints(undefined) returns an object');
console.log('  ✓ never returns undefined');

// --- neutral-intent detection ------------------------------------------
assert.strictEqual(isIntentNeutral(newIntent()), true, 'a fresh all-0.5 intent is neutral');
assert.strictEqual(isIntentNeutral(plan.intent), false, 'a weighted intent is not neutral');
const summaryOnly = newIntent();
summaryOnly.summary = 'reversibility above all';
assert.strictEqual(isIntentNeutral(summaryOnly), false, 'a written summary counts as commitment');
assert.strictEqual(isIntentNeutral({ axes: [] }), true, 'no axes is neutral');
console.log('  ✓ neutral-intent detection');

// --- no endpoint may read ws.intent / ws.constraints directly -----------
const guarded = [
  'api/generate-plan.js',
  'api/enrich-plan.js',
  'api/synthesize-target-json.js',
  'api/modify-target-json.js',
  'api/propose.js',
  'api/design-joinery.js'
];
const offenders = [];
for (const rel of guarded) {
  const file = path.join(repoRoot, rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf-8');
  src.split('\n').forEach((line, i) => {
    if (/\b(ws|workspace)\??\.(intent|constraints)\b/.test(line)) {
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    }
  });
}
assert.deepStrictEqual(
  offenders,
  [],
  'endpoints must read intent/constraints via workspace-read.js, not off the root:\n  ' + offenders.join('\n  ')
);
console.log('  ✓ no endpoint reads intent/constraints off the workspace root');

console.log('\n✓ Workspace read contract holds\n');
