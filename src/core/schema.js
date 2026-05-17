/**
 * Repair Workspace v2 — canonical data model.
 *
 * Every entity in the workspace is described here. The schema is the single
 * source of truth: views read it to know what to display, the migration script
 * uses it to validate, the AI prompts reference it so generated output is
 * consistent with what the UI expects.
 *
 * Design principles:
 *   1. Templates are reusable, instances are specific.
 *   2. Hypotheses (the old "damages") have a lifecycle: suspected → confirmed
 *      or refuted. A refutation is a finding, not a deletion.
 *   3. Evidence is first-class. Photos, measurements, notes — all anchored to
 *      a part, a hypothesis, or a step, with a timestamp.
 *   4. Intervention steps carry justifications back to the intent axes and
 *      hypotheses that produced them. "Why is this step here?" is answerable.
 *   5. Alternative branches are edges, not flags. A mutex group is explicit.
 *   6. Execution log is separate from plan. The plan is what you intend; the
 *      log is what actually happened, including deviations.
 *   7. Conversation threads are scoped and stateful. The thread *is* the
 *      design record.
 */

// v2.1.0 — intent + constraints moved from workspace root onto each plan.
// Plans are now "strategies": parallel alternative approaches to the same
// artefact, each with its own goals and constraints. See migrate.js for the
// v2.0 → v2.1 upgrade path.
export const SCHEMA_VERSION = '2.1.0';

// ============================================================================
// STATUS ENUMS — single source of truth for every status field in the system
// ============================================================================

export const PART_STATUS = ['intact', 'defective', 'missing', 'new', 'repaired', 'discarded'];
export const HYPOTHESIS_STATUS = ['suspected', 'confirmed', 'refuted'];
export const STEP_STATUS = ['pending', 'in-progress', 'completed', 'skipped', 'blocked'];
export const PLAN_STATUS = ['draft', 'active', 'completed', 'archived'];
export const EVIDENCE_KIND = ['photo', 'measurement', 'note', 'document', 'rendering'];
export const CHAT_SCOPE = ['global', 'instance', 'part', 'hypothesis', 'step', 'plan'];

// Fixed palette for strategies. Picked for legibility against the cream
// panel background, with each color reading clearly at small sizes (the
// 4px chip border in the sidebar). Round-robin assigned as strategies are
// created; first unused color wins, then wraps. Order is deliberate so
// the first few strategies a user creates pick up high-contrast hues.
export const STRATEGY_COLORS = [
  '#1f4e79', // deep teal-blue
  '#b8533a', // terracotta
  '#3f6b3f', // forest green
  '#7a4b8a', // plum
  '#c8932a', // mustard
  '#5a6b80', // slate blue
  '#8a4a2a', // rust
  '#2d4a52'  // charcoal-blue
];

// Pick a color for a new strategy: first one not already used by an
// existing plan, falling back to round-robin once the palette is exhausted.
export function pickStrategyColor(existingPlans = []) {
  const used = new Set(existingPlans.map(p => p?.color).filter(Boolean));
  const free = STRATEGY_COLORS.find(c => !used.has(c));
  if (free) return free;
  return STRATEGY_COLORS[existingPlans.length % STRATEGY_COLORS.length];
}

// ============================================================================
// FACTORIES — build empty entities ready to fill in
// ============================================================================

export function newWorkspace() {
  return {
    schemaVersion: SCHEMA_VERSION,
    template: null,
    instance: newInstance(),
    evidence: [],
    hypotheses: [],
    // intent + constraints are no longer here — they live on each plan
    // (strategy). See newPlan().
    plans: [],
    currentPlanId: null,
    executionLog: [],
    conversations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function newInstance(objectName = 'untitled object') {
  return {
    id: uid('inst'),
    name: objectName,
    templateRef: null,
    parts: [],
    location: null,
    provenance: null,
    notes: '',
    // Optional cover image as a data URL. Travels with the workspace
    // (reload, JSON export, sharing). Examples seed this from their
    // cover.jpg on load; future user-uploaded covers would write here too.
    coverImage: null,
    createdAt: new Date().toISOString()
  };
}

export function newPart(id, opts = {}) {
  return {
    id,
    label: opts.label || humanize(id),
    origin: opts.origin || { x: 0, y: 0, z: 0 },
    dimensions: opts.dimensions || { width: 0.1, height: 0.1, depth: 0.1 },
    rotation: opts.rotation || { x: 0, y: 0, z: 0 },
    connections: opts.connections || [],
    material: opts.material || '',
    status: opts.status || 'intact',
    notes: opts.notes || ''
  };
}

export function newHypothesis(opts = {}) {
  return {
    id: uid('hyp'),
    type: opts.type || 'observation',
    description: opts.description || '',
    partRef: opts.partRef || null,
    coordinates: opts.coordinates || null,
    status: opts.status || 'suspected',
    confidence: opts.confidence ?? 0.5,
    evidenceRefs: opts.evidenceRefs || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function newEvidence(kind, opts = {}) {
  if (!EVIDENCE_KIND.includes(kind)) throw new Error(`Unknown evidence kind: ${kind}`);
  return {
    id: uid('ev'),
    kind,
    attachedTo: opts.attachedTo || null,
    capturedAt: opts.capturedAt || new Date().toISOString(),
    capturedBy: opts.capturedBy || null,
    url: opts.url || null,
    text: opts.text || null,
    measurement: opts.measurement || null,
    confirmsHypothesisRef: opts.confirmsHypothesisRef || null,
    refutesHypothesisRef: opts.refutesHypothesisRef || null
  };
}

export function newIntent() {
  return {
    axes: [
      { id: 'axis_1', label: 'Material Authenticity', value: 0.5 },
      { id: 'axis_2', label: 'Structural Performance', value: 0.5 },
      { id: 'axis_3', label: 'Economic Viability', value: 0.5 },
      { id: 'axis_4', label: 'Cultural Continuity', value: 0.5 },
      { id: 'axis_5', label: 'Ecological Sustainability', value: 0.5 },
      { id: 'axis_6', label: 'Aesthetic Intervention', value: 0.5 }
    ],
    summary: ''
  };
}

export function newConstraints() {
  return {
    tools_available: '',
    materials_available: '',
    time_budget_minutes: 60,
    budget_limit: '',
    skill_level: 'intermediate',
    safety_level: 'normal',
    allowed_operations: '',
    avoid_operations: '',
    additional_constraints: ''
  };
}

export function newPlan(opts = {}) {
  return {
    id: uid('plan'),
    label: opts.label || 'Untitled strategy',
    status: opts.status || 'draft',
    // A strategy owns its own intent + constraints. Two strategies on the
    // same artefact can have completely different goals and limits.
    intent: opts.intent ? cloneDeep(opts.intent) : newIntent(),
    constraints: opts.constraints ? { ...opts.constraints } : newConstraints(),
    // Sidebar chip color. Caller (commands.js) assigns this from the
    // palette on creation; we don't pick a default here because we don't
    // know the existing plans.
    color: opts.color || null,
    steps: opts.steps || [],
    edges: opts.edges || [],
    mutexGroups: opts.mutexGroups || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// Small structured-clone helper used when a plan is duplicated and when
// intent objects are passed into newPlan. Avoids accidental shared refs
// between strategies (a hand-edit to one's intent would otherwise leak
// into another).
function cloneDeep(x) {
  return JSON.parse(JSON.stringify(x));
}

export function newStep(opts = {}) {
  return {
    id: opts.id || uid('step'),
    title: opts.title || 'Untitled step',
    description: opts.description || '',
    status: opts.status || 'pending',
    affectedPartRefs: opts.affectedPartRefs || [],
    addressesHypothesisRefs: opts.addressesHypothesisRefs || [],
    toolsRequired: opts.toolsRequired || [],
    materialsRequired: opts.materialsRequired || [],
    estimatedMinutes: opts.estimatedMinutes || null,
    expectedOutcome: opts.expectedOutcome || '',
    safetyNotes: opts.safetyNotes || '',
    justification: opts.justification || newJustification(),
    confidence: opts.confidence ?? 0.7,
    optional: !!opts.optional
  };
}

export function newJustification(opts = {}) {
  return {
    drivingIntentAxes: opts.drivingIntentAxes || [],
    drivingHypotheses: opts.drivingHypotheses || [],
    drivingConstraints: opts.drivingConstraints || [],
    rationale: opts.rationale || ''
  };
}

export function newEdge(sourceStepId, targetStepId) {
  return { id: uid('edge'), source: sourceStepId, target: targetStepId };
}

export function newMutexGroup(stepIds, opts = {}) {
  return {
    id: uid('mutex'),
    stepIds: Array.isArray(stepIds) ? [...stepIds] : [],
    label: opts.label || 'Pick one approach',
    selectedStepId: opts.selectedStepId || null
  };
}

export function newExecutionEntry(stepId, opts = {}) {
  return {
    id: uid('exec'),
    stepRef: stepId,
    completedAt: opts.completedAt || new Date().toISOString(),
    completedBy: opts.completedBy || null,
    actualDurationMinutes: opts.actualDurationMinutes || null,
    outcome: opts.outcome || 'as-planned',
    deviation: opts.deviation || '',
    rationale: opts.rationale || '',
    evidenceRefs: opts.evidenceRefs || []
  };
}

export function newConversation(scope, ref = null) {
  if (!CHAT_SCOPE.includes(scope)) throw new Error(`Unknown chat scope: ${scope}`);
  return {
    id: uid('thread'),
    scope,
    ref,
    messages: [],
    createdAt: new Date().toISOString()
  };
}

export function newMessage(role, content) {
  return {
    id: uid('msg'),
    role,
    content,
    createdAt: new Date().toISOString()
  };
}

// ============================================================================
// LOOKUPS — small helpers so callers don't repeat the .find() everywhere.
// Treat these as the canonical way to read intent + constraints; in v2.1
// they're scoped to the current plan (strategy), not the workspace root.
// ============================================================================

export function getCurrentPlan(ws) {
  if (!ws) return null;
  return (ws.plans || []).find(p => p.id === ws.currentPlanId) || null;
}

// Returns a usable intent object even when there's no current plan yet,
// so views that read it during the initial empty state don't crash.
export function getCurrentIntent(ws) {
  return getCurrentPlan(ws)?.intent || newIntent();
}

export function getCurrentConstraints(ws) {
  return getCurrentPlan(ws)?.constraints || newConstraints();
}

// ============================================================================
// HELPERS
// ============================================================================

let counter = 0;
function uid(prefix) {
  counter += 1;
  const t = Date.now().toString(36);
  const c = counter.toString(36).padStart(3, '0');
  return `${prefix}_${t}${c}`;
}

function humanize(id) {
  return String(id || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ============================================================================
// VALIDATION — lightweight; throw on obvious malformation
// ============================================================================

export function validateWorkspace(ws) {
  const errors = [];
  if (!ws) errors.push('Workspace is null');
  if (!ws.schemaVersion) errors.push('Missing schemaVersion');
  if (ws.schemaVersion !== SCHEMA_VERSION) errors.push(`Schema version mismatch: ${ws.schemaVersion} vs ${SCHEMA_VERSION}`);
  if (!ws.instance) errors.push('Missing instance');
  if (ws.instance && !Array.isArray(ws.instance.parts)) errors.push('instance.parts must be an array');
  if (!Array.isArray(ws.hypotheses)) errors.push('hypotheses must be an array');
  if (!Array.isArray(ws.evidence)) errors.push('evidence must be an array');
  if (!Array.isArray(ws.plans)) errors.push('plans must be an array');
  if (!Array.isArray(ws.executionLog)) errors.push('executionLog must be an array');

  (ws.hypotheses || []).forEach((h, i) => {
    if (!HYPOTHESIS_STATUS.includes(h.status)) errors.push(`hypotheses[${i}].status invalid: ${h.status}`);
  });
  (ws.plans || []).forEach((p, i) => {
    if (!PLAN_STATUS.includes(p.status)) errors.push(`plans[${i}].status invalid: ${p.status}`);
    // v2.1 contract: intent + constraints live on every plan. Migration
    // populates them; new plans go through newPlan() which sets defaults.
    if (!p.intent) errors.push(`plans[${i}] missing intent`);
    if (!p.constraints) errors.push(`plans[${i}] missing constraints`);
  });
  return { ok: errors.length === 0, errors };
}
