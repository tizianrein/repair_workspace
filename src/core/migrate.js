/**
 * Migrate v1 → v2 workspace JSON.
 *
 * The old shape:
 *   { objectName, assembly: { parts: [...] }, damages: [...], plan: { steps: [...] },
 *     planVersions: [...], currentPlanVersionId, currentStepId, intent, constraints }
 *
 * The new shape: see schema.js. The mapping is:
 *   - assembly.parts          → instance.parts (status enum tightened)
 *   - damages                 → conditions (each gets status='suspected', evidence=[])
 *   - plan.steps              → plans[currentPlanIdx].steps (prerequisites → edges)
 *   - planVersions            → plans[]
 *   - intent, constraints      → in v2.0 these lived at workspace root; in
 *                                v2.1 they were lifted onto each plan
 *                                (strategy). This script writes v2.1 directly.
 *   - currentStepId            → not preserved; users re-select on load
 *   - photos                   → not migrated; they were never anchored anyway
 *
 * Returns { workspace, warnings } where warnings is a list of strings describing
 * any data that couldn't be perfectly mapped.
 */

import {
  newWorkspace, newInstance, newPart, newCondition,
  newPlan, newStep, newEdge, newIntent, newConstraints,
  pickStrategyColor, PART_STATUS, SCHEMA_VERSION
} from './schema.js';

export function migrateV1ToV2(v1) {
  // Already on v2.1: nothing to do. This keeps the function idempotent —
  // any code path that runs migration twice (test, hot-reload, etc.)
  // gets the same workspace back unchanged.
  if (v1 && v1.schemaVersion && /^2\.1/.test(v1.schemaVersion)) {
    return { workspace: v1, warnings: [] };
  }

  // Detect a v2.0 workspace (already has the v2 shape but with intent +
  // constraints at the root) and route to the lighter v2.0 → v2.1 fixup.
  // This is what most existing users will hit — they have v2.0 JSON files
  // saved from a previous run.
  if (v1 && v1.schemaVersion && /^2\.0/.test(v1.schemaVersion)) {
    return upgradeV20ToV21(v1);
  }

  const warnings = [];
  const ws = newWorkspace();

  // Instance
  ws.instance = newInstance(v1.objectName || v1.assembly?.objectName || 'untitled');

  const v1Parts = v1.assembly?.parts || v1.parts || [];
  ws.instance.parts = v1Parts.map(p => {
    const status = normalizePartStatus(p.status, warnings, p.id);
    return newPart(p.id, {
      label: p.label,
      origin: p.origin || { x: 0, y: 0, z: 0 },
      dimensions: p.dimensions || {},
      rotation: p.rotation || { x: 0, y: 0, z: 0 },
      connections: p.connections || [],
      material: p.material || '',
      status,
      notes: p.notes || ''
    });
  });

  // Conditions — old "damages"
  const v1Damages = Array.isArray(v1.damages) ? v1.damages : [];
  const oldToNewConditionId = new Map();
  v1Damages.forEach(d => {
    const h = newCondition({
      type: d.type || 'observation',
      description: d.description || '',
      partRef: d.part_id || null,
      coordinates: d.coordinates || null,
      status: 'suspected',
      confidence: 0.6
    });
    oldToNewConditionId.set(d.id, h.id);
    ws.conditions.push(h);
  });

  // Intent — in v1 it lived at the workspace root. In v2.1 it lives on
  // each plan, so we derive it here and apply it to every migrated plan
  // below.
  let intent = newIntent();
  if (v1.intent && Array.isArray(v1.intent.axes) && v1.intent.axes.length) {
    intent = {
      ...intent,
      axes: v1.intent.axes.map((a, i) => ({
        id: a.id || `axis_${i + 1}`,
        label: a.label || `Axis ${i + 1}`,
        value: clamp01(Number(a.value) || 0.5)
      })),
      summary: v1.intent.summary || ''
    };
  }

  // Constraints — same story as intent.
  let constraints = newConstraints();
  if (v1.constraints) constraints = { ...constraints, ...v1.constraints };

  // Plan versions become plans[]. In v2.0 these were time-ordered edit
  // history. In v2.1 they're parallel strategies — we still preserve the
  // count, so a user with multiple versions gets multiple strategies and
  // can prune the ones they don't want.
  const v1Versions = Array.isArray(v1.planVersions) ? v1.planVersions : [];
  const currentPlanRef = v1.plan || v1Versions[v1Versions.length - 1]?.plan || null;

  if (v1Versions.length === 0 && currentPlanRef && currentPlanRef.steps?.length) {
    const p = migratePlan(currentPlanRef, 'Imported strategy', oldToNewConditionId, warnings);
    p.intent = cloneDeep(intent);
    p.constraints = { ...constraints };
    p.color = pickStrategyColor(ws.plans);
    ws.plans.push(p);
    ws.currentPlanId = p.id;
  } else if (v1Versions.length) {
    v1Versions.forEach(v => {
      const p = migratePlan(v.plan, v.label || 'Imported strategy', oldToNewConditionId, warnings);
      // Each migrated strategy gets its own copy of the intent/constraints
      // so the user can diverge them independently from here on.
      p.intent = cloneDeep(intent);
      p.constraints = { ...constraints };
      p.color = pickStrategyColor(ws.plans);
      ws.plans.push(p);
    });
    ws.currentPlanId = ws.plans[ws.plans.length - 1].id;
  }

  // If nothing produced a plan at all, seed a single empty strategy that
  // carries the user's intent/constraints, so they have somewhere to start.
  if (!ws.plans.length) {
    const seed = newPlan({
      label: 'Strategy 1',
      intent,
      constraints,
      color: pickStrategyColor(ws.plans)
    });
    ws.plans.push(seed);
    ws.currentPlanId = seed.id;
  }

  if (v1.photos && v1.photos.length) {
    warnings.push(`${v1.photos.length} inline photo(s) were not migrated — anchor them to evidence after import.`);
  }
  if (v1.currentStepId) {
    warnings.push(`Selected step "${v1.currentStepId}" was not preserved; re-select after load.`);
  }

  ws.schemaVersion = SCHEMA_VERSION;
  return { workspace: ws, warnings };
}

function migratePlan(v1Plan, label, oldToNewConditionId, warnings) {
  const plan = newPlan({ label, status: 'draft' });
  const oldToNewStepId = new Map();

  (v1Plan?.steps || []).forEach(s => {
    const newId = s.step_id || s.id;
    if (!newId) {
      warnings.push(`Step missing id, skipped.`);
      return;
    }
    const addressed = (s.affected_damages || s.addresses_damages || [])
      .map(oid => oldToNewConditionId.get(oid))
      .filter(Boolean);

    const step = newStep({
      id: newId,
      title: s.title || newId,
      description: s.description || '',
      status: s.completed ? 'completed' : 'pending',
      affectedPartRefs: s.affected_parts || [],
      addressesConditionRefs: addressed,
      toolsRequired: s.tools_required || [],
      materialsRequired: s.materials_required || [],
      estimatedMinutes: s.estimated_minutes || null,
      expectedOutcome: s.expected_outcome || '',
      safetyNotes: s.safety_notes || '',
      optional: !!s.optional,
      justification: {
        drivingIntentAxes: [],
        drivingConditions: addressed,
        drivingConstraints: [],
        rationale: 'Migrated from v1; rationale not recorded.'
      },
      confidence: 0.6
    });
    oldToNewStepId.set(newId, step.id);
    plan.steps.push(step);
  });

  (v1Plan?.steps || []).forEach(s => {
    const tgtId = oldToNewStepId.get(s.step_id || s.id);
    if (!tgtId) return;
    (s.prerequisites || []).forEach(pre => {
      const srcId = oldToNewStepId.get(pre);
      if (srcId) plan.edges.push(newEdge(srcId, tgtId));
      else warnings.push(`Step "${s.step_id}" referenced unknown prerequisite "${pre}".`);
    });
  });

  return plan;
}

function normalizePartStatus(status, warnings, partId) {
  if (!status) return 'intact';
  if (PART_STATUS.includes(status)) return status;
  const map = {
    damaged: 'defective',
    broken: 'defective',
    ok: 'intact',
    null: 'intact'
  };
  if (map[status]) return map[status];
  warnings.push(`Unknown part status "${status}" on "${partId}", treated as intact.`);
  return 'intact';
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function cloneDeep(x) { return JSON.parse(JSON.stringify(x)); }

// ============================================================================
// v2.0 → v2.1 upgrade
// ============================================================================
// v2.0 had intent + constraints at the workspace root and treated
// `plans[]` as a linear edit history. v2.1 moves both onto each plan and
// reframes plans as parallel strategies. We can do this in-place:
//
//  - copy root intent/constraints onto every existing plan
//  - assign each plan a color from the palette
//  - tag any existing renderings (kind='rendering' evidence) with the
//    current plan so they don't dangle. Best-effort: if there's no
//    currentPlanId, attach to the first plan.
//  - bump schemaVersion
//
// Idempotent: re-running on an already-upgraded workspace is a no-op.
function upgradeV20ToV21(v20) {
  const warnings = [];
  const ws = cloneDeep(v20);

  const rootIntent = ws.intent || null;
  const rootConstraints = ws.constraints || null;

  // Ensure at least one plan exists, otherwise we have nowhere to put
  // intent/constraints. Seed a blank strategy carrying the root values.
  if (!Array.isArray(ws.plans) || ws.plans.length === 0) {
    const seed = newPlan({
      label: 'Strategy 1',
      intent: rootIntent || newIntent(),
      constraints: rootConstraints || newConstraints()
    });
    seed.color = pickStrategyColor([]);
    ws.plans = [seed];
    ws.currentPlanId = seed.id;
  } else {
    // Walk every plan and fill in the new fields where missing. We only
    // overwrite when the plan doesn't already have a value (idempotency).
    const assigned = [];
    ws.plans = ws.plans.map(p => {
      const next = { ...p };
      if (!next.intent) next.intent = rootIntent ? cloneDeep(rootIntent) : newIntent();
      if (!next.constraints) next.constraints = rootConstraints ? { ...rootConstraints } : newConstraints();
      if (!next.color) next.color = pickStrategyColor(assigned);
      assigned.push(next);
      return next;
    });
    if (!ws.currentPlanId) ws.currentPlanId = ws.plans[0].id;
  }

  // Tag existing renderings with the current plan. Real provenance is
  // unrecoverable — we can't know which plan version produced a v2.0
  // rendering — so we attach all to the current plan. The user can
  // delete and regenerate per strategy if they care.
  const renderings = (ws.evidence || []).filter(e => e.kind === 'rendering');
  if (renderings.length) {
    const targetPlanId = ws.currentPlanId;
    ws.evidence = ws.evidence.map(e => {
      if (e.kind !== 'rendering' || e.planRef) return e;
      return { ...e, planRef: targetPlanId };
    });
    warnings.push(`${renderings.length} imagined-result image(s) were attached to the current strategy. Regenerate per strategy if you want them strategy-specific.`);
  }

  // Drop root intent/constraints — they're owned by plans now.
  delete ws.intent;
  delete ws.constraints;

  ws.schemaVersion = SCHEMA_VERSION;
  return { workspace: ws, warnings };
}
