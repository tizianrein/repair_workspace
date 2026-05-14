/**
 * Migrate v1 → v2 workspace JSON.
 *
 * The old shape:
 *   { objectName, assembly: { parts: [...] }, damages: [...], plan: { steps: [...] },
 *     planVersions: [...], currentPlanVersionId, currentStepId, intent, constraints }
 *
 * The new shape: see schema.js. The mapping is:
 *   - assembly.parts          → instance.parts (status enum tightened)
 *   - damages                 → hypotheses (each gets status='suspected', evidence=[])
 *   - plan.steps              → plans[currentPlanIdx].steps (prerequisites → edges)
 *   - planVersions            → plans[]
 *   - intent, constraints      → kept as-is
 *   - currentStepId            → not preserved; users re-select on load
 *   - photos                   → not migrated; they were never anchored anyway
 *
 * Returns { workspace, warnings } where warnings is a list of strings describing
 * any data that couldn't be perfectly mapped.
 */

import {
  newWorkspace, newInstance, newPart, newHypothesis,
  newPlan, newStep, newEdge, newIntent, newConstraints,
  PART_STATUS, SCHEMA_VERSION
} from './schema.js';

export function migrateV1ToV2(v1) {
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

  // Hypotheses — old "damages"
  const v1Damages = Array.isArray(v1.damages) ? v1.damages : [];
  const oldToNewHypothesisId = new Map();
  v1Damages.forEach(d => {
    const h = newHypothesis({
      type: d.type || 'observation',
      description: d.description || '',
      partRef: d.part_id || null,
      coordinates: d.coordinates || null,
      status: 'suspected',
      confidence: 0.6
    });
    oldToNewHypothesisId.set(d.id, h.id);
    ws.hypotheses.push(h);
  });

  // Intent
  if (v1.intent && Array.isArray(v1.intent.axes) && v1.intent.axes.length) {
    ws.intent = {
      ...newIntent(),
      axes: v1.intent.axes.map((a, i) => ({
        id: a.id || `axis_${i + 1}`,
        label: a.label || `Axis ${i + 1}`,
        value: clamp01(Number(a.value) || 0.5)
      })),
      summary: v1.intent.summary || ''
    };
  }

  // Constraints
  if (v1.constraints) ws.constraints = { ...newConstraints(), ...v1.constraints };

  // Plan versions become plans[]
  const v1Versions = Array.isArray(v1.planVersions) ? v1.planVersions : [];
  const currentPlanRef = v1.plan || v1Versions[v1Versions.length - 1]?.plan || null;

  if (v1Versions.length === 0 && currentPlanRef && currentPlanRef.steps?.length) {
    const p = migratePlan(currentPlanRef, 'Imported plan', oldToNewHypothesisId, warnings);
    ws.plans.push(p);
    ws.currentPlanId = p.id;
  } else if (v1Versions.length) {
    v1Versions.forEach(v => {
      const p = migratePlan(v.plan, v.label || 'Imported plan', oldToNewHypothesisId, warnings);
      ws.plans.push(p);
    });
    ws.currentPlanId = ws.plans[ws.plans.length - 1].id;
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

function migratePlan(v1Plan, label, oldToNewHypothesisId, warnings) {
  const plan = newPlan({ label, status: 'draft' });
  const oldToNewStepId = new Map();

  (v1Plan?.steps || []).forEach(s => {
    const newId = s.step_id || s.id;
    if (!newId) {
      warnings.push(`Step missing id, skipped.`);
      return;
    }
    const addressed = (s.affected_damages || s.addresses_damages || [])
      .map(oid => oldToNewHypothesisId.get(oid))
      .filter(Boolean);

    const step = newStep({
      id: newId,
      title: s.title || newId,
      description: s.description || '',
      status: s.completed ? 'completed' : 'pending',
      affectedPartRefs: s.affected_parts || [],
      addressesHypothesisRefs: addressed,
      toolsRequired: s.tools_required || [],
      materialsRequired: s.materials_required || [],
      estimatedMinutes: s.estimated_minutes || null,
      expectedOutcome: s.expected_outcome || '',
      safetyNotes: s.safety_notes || '',
      optional: !!s.optional,
      justification: {
        drivingIntentAxes: [],
        drivingHypotheses: addressed,
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
