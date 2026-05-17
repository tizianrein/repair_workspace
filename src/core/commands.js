/**
 * Command pattern.
 *
 * Every state mutation is a Command: a pure function that takes the current
 * workspace and returns { workspace, inverse }. The inverse is a Command that
 * undoes the change. Commands are recorded in a log, giving us undo and audit
 * for free.
 *
 * Usage:
 *   import { apply, undo, redo, defineCommand } from './commands.js';
 *   apply(state, { type: 'add-hypothesis', payload: {...} });
 *   undo(state);
 *
 * AI-proposed changes go through the same path: the model returns a list of
 * commands, each is applied, and the message records which commands it
 * triggered (so "show me what the AI changed" is one query).
 */

import {
  newHypothesis, newEvidence, newPlan, newStep, newEdge, newMutexGroup,
  newExecutionEntry, newConversation, newMessage,
  newIntent, newConstraints, pickStrategyColor
} from './schema.js';

const registry = new Map();

export function defineCommand(type, handler) { registry.set(type, handler); }

export function apply(state, command, opts = {}) {
  const handler = registry.get(command.type);
  if (!handler) throw new Error(`Unknown command type: ${command.type}`);
  const result = handler(state.workspace, command.payload);
  state.workspace = result.workspace;
  state.workspace.updatedAt = new Date().toISOString();
  const recorded = {
    type: command.type,
    payload: command.payload,
    inverse: result.inverse,
    appliedAt: new Date().toISOString()
  };
  // skipHistory: applied changes that should NOT be undoable. Used for
  // chat messages, where Ctrl+Z popping the last AI reply would be
  // surprising and unhelpful. The mutation still goes through the
  // workspace + listeners + autoPersist, just not into history/future.
  if (!opts.skipHistory) {
    state.history.push(recorded);
    state.future = [];
  }
  state.listeners.forEach(fn => fn(state.workspace, recorded));
  return recorded;
}

export function undo(state) {
  const last = state.history.pop();
  if (!last) return null;
  const handler = registry.get(last.inverse.type);
  const result = handler(state.workspace, last.inverse.payload);
  state.workspace = result.workspace;
  state.workspace.updatedAt = new Date().toISOString();
  state.future.push(last);
  state.listeners.forEach(fn => fn(state.workspace, { type: 'undo', undone: last }));
  return last;
}

export function redo(state) {
  const next = state.future.pop();
  if (!next) return null;
  return apply(state, { type: next.type, payload: next.payload });
}

// ============================================================================
// COMMAND DEFINITIONS
// ============================================================================

defineCommand('set-object-name', (ws, { name }) => {
  const prev = ws.instance.name;
  return {
    workspace: { ...ws, instance: { ...ws.instance, name } },
    inverse: { type: 'set-object-name', payload: { name: prev } }
  };
});

defineCommand('upsert-part', (ws, { part }) => {
  const parts = ws.instance?.parts || [];
  const idx = parts.findIndex(p => p.id === part.id);
  const prev = idx >= 0 ? parts[idx] : null;
  // Same logic as upsert-step: if the part exists, treat the payload as a
  // partial update and preserve fields not explicitly overridden. Otherwise
  // accept the payload as-is.
  const merged = prev ? { ...prev, ...part } : part;
  const next = idx >= 0
    ? parts.map((p, i) => i === idx ? merged : p)
    : [...parts, merged];
  return {
    workspace: { ...ws, instance: { ...ws.instance, parts: next } },
    inverse: prev
      ? { type: 'upsert-part', payload: { part: prev } }
      : { type: 'remove-part', payload: { partId: part.id } }
  };
});

defineCommand('remove-part', (ws, { partId }) => {
  const removed = ws.instance.parts.find(p => p.id === partId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  return {
    workspace: { ...ws, instance: { ...ws.instance, parts: ws.instance.parts.filter(p => p.id !== partId) } },
    inverse: { type: 'upsert-part', payload: { part: removed } }
  };
});

defineCommand('replace-assembly', (ws, { parts, objectName }) => {
  const instance = ws.instance || { parts: [] };
  const prevParts = instance.parts || [];
  const prevName = instance.name;
  if (!Array.isArray(parts)) {
    throw new Error(`replace-assembly: parts must be an array (got ${typeof parts})`);
  }
  return {
    workspace: { ...ws, instance: { ...instance, parts, name: objectName || instance.name } },
    inverse: { type: 'replace-assembly', payload: { parts: prevParts, objectName: prevName } }
  };
});

defineCommand('add-hypothesis', (ws, { hypothesis }) => {
  const h = { ...newHypothesis(), ...hypothesis };
  return {
    workspace: { ...ws, hypotheses: [...(ws.hypotheses || []), h] },
    inverse: { type: 'remove-hypothesis', payload: { hypothesisId: h.id } }
  };
});

defineCommand('update-hypothesis', (ws, { hypothesisId, patch }) => {
  const idx = ws.hypotheses.findIndex(h => h.id === hypothesisId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const prev = ws.hypotheses[idx];
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  return {
    workspace: { ...ws, hypotheses: ws.hypotheses.map((h, i) => i === idx ? next : h) },
    inverse: { type: 'update-hypothesis', payload: { hypothesisId, patch: prev } }
  };
});

defineCommand('remove-hypothesis', (ws, { hypothesisId }) => {
  const removed = ws.hypotheses.find(h => h.id === hypothesisId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  return {
    workspace: { ...ws, hypotheses: ws.hypotheses.filter(h => h.id !== hypothesisId) },
    inverse: { type: 'add-hypothesis', payload: { hypothesis: removed } }
  };
});

defineCommand('confirm-hypothesis', (ws, { hypothesisId, evidenceId }) => {
  const prev = ws.hypotheses.find(h => h.id === hypothesisId);
  if (!prev) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const next = { ...prev, status: 'confirmed', confidence: 1.0, evidenceRefs: [...(prev.evidenceRefs || []), evidenceId].filter(Boolean), updatedAt: new Date().toISOString() };
  return {
    workspace: { ...ws, hypotheses: ws.hypotheses.map(h => h.id === hypothesisId ? next : h) },
    inverse: { type: 'update-hypothesis', payload: { hypothesisId, patch: prev } }
  };
});

defineCommand('refute-hypothesis', (ws, { hypothesisId, evidenceId, note }) => {
  const prev = ws.hypotheses.find(h => h.id === hypothesisId);
  if (!prev) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const next = {
    ...prev,
    status: 'refuted',
    confidence: 0,
    evidenceRefs: [...(prev.evidenceRefs || []), evidenceId].filter(Boolean),
    description: note ? `${prev.description}\n\n[REFUTED] ${note}` : prev.description,
    updatedAt: new Date().toISOString()
  };
  return {
    workspace: { ...ws, hypotheses: ws.hypotheses.map(h => h.id === hypothesisId ? next : h) },
    inverse: { type: 'update-hypothesis', payload: { hypothesisId, patch: prev } }
  };
});

defineCommand('add-evidence', (ws, { evidence }) => {
  const e = { ...newEvidence(evidence.kind), ...evidence };
  return {
    workspace: { ...ws, evidence: [...(ws.evidence || []), e] },
    inverse: { type: 'remove-evidence', payload: { evidenceId: e.id } }
  };
});

defineCommand('remove-evidence', (ws, { evidenceId }) => {
  const removed = ws.evidence.find(e => e.id === evidenceId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  return {
    workspace: { ...ws, evidence: ws.evidence.filter(e => e.id !== evidenceId) },
    inverse: { type: 'add-evidence', payload: { evidence: removed } }
  };
});

// In v2.1, intent and constraints live on the current plan (strategy),
// not the workspace root. These commands are written in terms of plans
// but keep their original names so existing callers don't need to change.

defineCommand('set-intent', (ws, { intent }) => {
  const idx = (ws.plans || []).findIndex(p => p.id === ws.currentPlanId);
  if (idx < 0) {
    // No current strategy to attach intent to. Stash on the workspace
    // root as a transient "pending intent" so user edits aren't lost; the
    // next add-plan / duplicate-plan will pick it up if the caller wants.
    // We don't promise this behaviour publicly — it's a defensive default
    // for the brief window between fresh workspace and first strategy.
    const prev = ws._pendingIntent || null;
    return {
      workspace: { ...ws, _pendingIntent: { ...(prev || newIntent()), ...intent } },
      inverse: { type: 'set-intent', payload: { intent: prev || newIntent() } }
    };
  }
  const plan = ws.plans[idx];
  const prev = plan.intent;
  const merged = { ...prev, ...intent };
  return {
    workspace: {
      ...ws,
      plans: ws.plans.map((p, i) => i === idx
        ? { ...p, intent: merged, updatedAt: new Date().toISOString() }
        : p)
    },
    inverse: { type: 'set-intent', payload: { intent: prev } }
  };
});

defineCommand('set-constraints', (ws, { constraints }) => {
  const idx = (ws.plans || []).findIndex(p => p.id === ws.currentPlanId);
  if (idx < 0) {
    const prev = ws._pendingConstraints || null;
    return {
      workspace: { ...ws, _pendingConstraints: { ...(prev || newConstraints()), ...constraints } },
      inverse: { type: 'set-constraints', payload: { constraints: prev || newConstraints() } }
    };
  }
  const plan = ws.plans[idx];
  const prev = plan.constraints;
  const merged = { ...prev, ...constraints };
  return {
    workspace: {
      ...ws,
      plans: ws.plans.map((p, i) => i === idx
        ? { ...p, constraints: merged, updatedAt: new Date().toISOString() }
        : p)
    },
    inverse: { type: 'set-constraints', payload: { constraints: prev } }
  };
});

defineCommand('add-plan', (ws, { plan }) => {
  const base = newPlan();
  const merged = { ...base, ...plan };
  // Auto-assign a color from the palette if the caller didn't specify
  // one. Strategies always have a color in v2.1.
  if (!merged.color) merged.color = pickStrategyColor(ws.plans || []);
  // If the user was editing intent/constraints before any plan existed
  // (the empty-workspace case), promote those _pendingX stashes onto the
  // first plan so the edits aren't lost.
  if (!plan?.intent && ws._pendingIntent) merged.intent = { ...merged.intent, ...ws._pendingIntent };
  if (!plan?.constraints && ws._pendingConstraints) merged.constraints = { ...merged.constraints, ...ws._pendingConstraints };
  const next = {
    ...ws,
    plans: [...(ws.plans || []), merged],
    currentPlanId: merged.id
  };
  delete next._pendingIntent;
  delete next._pendingConstraints;
  return {
    workspace: next,
    inverse: { type: 'remove-plan', payload: { planId: merged.id } }
  };
});

defineCommand('remove-plan', (ws, { planId }) => {
  const removed = ws.plans.find(p => p.id === planId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const remaining = ws.plans.filter(p => p.id !== planId);
  // If we just removed the current strategy, fall back to the first
  // remaining one so the user is never left with no active strategy
  // (which would hide intent + constraints from the UI).
  let currentPlanId = ws.currentPlanId;
  if (currentPlanId === planId) {
    currentPlanId = remaining[0]?.id || null;
  }
  // Drop the plan's chat thread too — it's now orphaned. The undo path
  // restores the plan but NOT the thread; that's an accepted limitation,
  // since chat history is meant to be a record of a strategy's design
  // and a deleted strategy's chat is rarely what the user wants back.
  const remainingConversations = (ws.conversations || []).filter(
    t => !(t.scope === 'plan' && t.ref === planId)
  );
  return {
    workspace: { ...ws, plans: remaining, currentPlanId, conversations: remainingConversations },
    inverse: { type: 'add-plan', payload: { plan: removed } }
  };
});

defineCommand('set-current-plan', (ws, { planId }) => {
  const prev = ws.currentPlanId;
  return {
    workspace: { ...ws, currentPlanId: planId },
    inverse: { type: 'set-current-plan', payload: { planId: prev } }
  };
});

// Duplicate an existing plan as a new strategy. Everything plan-scoped
// comes along: intent (deep-cloned so edits don't leak between
// strategies), constraints, steps, edges, mutexGroups. Step IDs are
// remapped to fresh ones so the original and the copy can coexist and
// be edited independently. Hypotheses, parts, and evidence are
// artefact-scoped and untouched. Renderings (evidence kind='rendering')
// that point at the source plan get cloned references so the copy
// starts with the same imagined results.
defineCommand('duplicate-plan', (ws, { sourcePlanId, label }) => {
  const source = (ws.plans || []).find(p => p.id === sourcePlanId);
  if (!source) return { workspace: ws, inverse: { type: 'noop', payload: {} } };

  // Build the new plan with fresh step IDs. newStep() preserves opts.id
  // when given one (used by upsert), so we strip the source id before
  // delegating, forcing a fresh id from the uid() counter.
  const idMap = new Map();
  const newSteps = (source.steps || []).map(s => {
    const { id: _drop, ...rest } = s;
    const fresh = newStep(rest);
    idMap.set(s.id, fresh.id);
    return fresh;
  });
  const newEdges = (source.edges || [])
    .map(e => {
      const src = idMap.get(e.source);
      const tgt = idMap.get(e.target);
      return (src && tgt) ? newEdge(src, tgt) : null;
    })
    .filter(Boolean);
  const newMutex = (source.mutexGroups || []).map(g => {
    const mappedIds = (g.stepIds || []).map(id => idMap.get(id)).filter(Boolean);
    if (mappedIds.length < 2) return null;
    return newMutexGroup(mappedIds, {
      label: g.label,
      selectedStepId: g.selectedStepId ? idMap.get(g.selectedStepId) || null : null
    });
  }).filter(Boolean);

  const copy = newPlan({
    label: label || `${source.label} (copy)`,
    status: 'draft',
    intent: source.intent,            // newPlan() deep-clones internally
    constraints: source.constraints,
    color: pickStrategyColor(ws.plans),
    steps: newSteps,
    edges: newEdges,
    mutexGroups: newMutex
  });

  // Clone any renderings that belonged to the source strategy. Each gets
  // a fresh evidence ID so the source's rendering thumbnails aren't
  // affected by edits to the copy. The image blob in IndexedDB is
  // referenced by id, so we copy the id reference too — both strategies
  // now point at the same image bytes, but since renderings are
  // immutable in this app (you regenerate to change them), that's safe.
  const clonedRenderings = (ws.evidence || [])
    .filter(e => e.kind === 'rendering' && e.planRef === sourcePlanId)
    .map(e => {
      const fresh = newEvidence('rendering', {
        attachedTo: e.attachedTo,
        url: e.url,
        text: e.text
      });
      // Carry the rendering-specific fields the factory doesn't know about
      // and stamp the new plan reference.
      fresh.fileName = e.fileName;
      fresh.byteSize = e.byteSize;
      fresh.basedOnSourceEvidenceId = e.basedOnSourceEvidenceId;
      fresh.sollJson = e.sollJson;
      fresh.istJson = e.istJson;
      fresh.planRef = copy.id;
      return fresh;
    });

  // Clone the plan's chat thread too. Duplicating a strategy is forking
  // the design; the conversation that shaped the source should travel
  // with the fork. We keep the source's thread intact and clone messages
  // into a fresh thread for the new plan. Other scopes (global, part,
  // condition, step) are not plan-scoped and are left alone.
  const sourceThread = (ws.conversations || []).find(t => t.scope === 'plan' && t.ref === sourcePlanId);
  const clonedConversations = [];
  if (sourceThread) {
    const fresh = newConversation('plan', copy.id);
    // Copy messages with fresh ids; preserve role + content + timestamp.
    fresh.messages = (sourceThread.messages || []).map(m => {
      const c = newMessage(m.role, m.content);
      // Carry forward any role-specific extras the assistant stores on the
      // message (toolCalls, plannedSummary, followUpOptions). These don't
      // affect the workspace state but they keep the visual record intact.
      if (m.toolCalls)         c.toolCalls = m.toolCalls;
      if (m.plannedSummary)    c.plannedSummary = m.plannedSummary;
      if (m.followUpOptions)   c.followUpOptions = m.followUpOptions;
      if (m.suggestedAction)   c.suggestedAction = m.suggestedAction;
      if (m.uncertainty)       c.uncertainty = m.uncertainty;
      return c;
    });
    clonedConversations.push(fresh);
  }

  return {
    workspace: {
      ...ws,
      plans: [...(ws.plans || []), copy],
      currentPlanId: copy.id,
      evidence: [...(ws.evidence || []), ...clonedRenderings],
      conversations: [...(ws.conversations || []), ...clonedConversations]
    },
    inverse: { type: 'remove-plan', payload: { planId: copy.id } }
  };
});

defineCommand('set-plan-status', (ws, { planId, status }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const prev = ws.plans[idx].status;
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? { ...p, status, updatedAt: new Date().toISOString() } : p) },
    inverse: { type: 'set-plan-status', payload: { planId, status: prev } }
  };
});

// Update plan-level metadata (label, status, color). For step-level edits
// use upsert-step / remove-step instead. Patch object is shallow-merged:
// only fields explicitly present are changed.
defineCommand('update-plan', (ws, { planId, patch }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const plan = ws.plans[idx];
  // Capture inverse before we mutate
  const prev = {};
  for (const k of Object.keys(patch || {})) prev[k] = plan[k];
  const updated = { ...plan, ...(patch || {}), updatedAt: new Date().toISOString() };
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? updated : p) },
    inverse: { type: 'update-plan', payload: { planId, patch: prev } }
  };
});

defineCommand('upsert-step', (ws, { planId, step }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) throw new Error(`upsert-step: no plan with id "${planId}" — make sure add-plan created it first, and that the planId matches`);
  const plan = ws.plans[idx];
  const planSteps = plan.steps || [];
  const stepIdx = planSteps.findIndex(s => s.id === step.id);
  const prev = stepIdx >= 0 ? planSteps[stepIdx] : null;
  // When updating an existing step, preserve all its current fields and only
  // overlay the ones explicitly present in the payload. Otherwise a partial
  // payload (e.g. AI sends only { id, description }) would wipe out every
  // other field — including tools, materials, justification — by re-applying
  // newStep() defaults. When creating a new step, use the defaults as the
  // base.
  const base = prev || newStep();
  const fullStep = { ...base, ...step };
  const newSteps = stepIdx >= 0
    ? planSteps.map((s, i) => i === stepIdx ? fullStep : s)
    : [...planSteps, fullStep];
  const newPlan = { ...plan, steps: newSteps, updatedAt: new Date().toISOString() };
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? newPlan : p) },
    inverse: prev
      ? { type: 'upsert-step', payload: { planId, step: prev } }
      : { type: 'remove-step', payload: { planId, stepId: fullStep.id } }
  };
});

defineCommand('remove-step', (ws, { planId, stepId }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const plan = ws.plans[idx];
  const removed = plan.steps.find(s => s.id === stepId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const newPlan = {
    ...plan,
    steps: plan.steps.filter(s => s.id !== stepId),
    edges: plan.edges.filter(e => e.source !== stepId && e.target !== stepId),
    mutexGroups: plan.mutexGroups.map(g => ({ ...g, stepIds: g.stepIds.filter(id => id !== stepId) })).filter(g => g.stepIds.length > 1),
    updatedAt: new Date().toISOString()
  };
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? newPlan : p) },
    inverse: { type: 'upsert-step', payload: { planId, step: removed } }
  };
});

defineCommand('add-edge', (ws, { planId, source, target }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) throw new Error(`add-edge: no plan with id "${planId}"`);
  const plan = ws.plans[idx];
  if (!source || !target) {
    throw new Error(`add-edge: source and target are required (got source="${source}", target="${target}")`);
  }
  const steps = plan.steps || [];
  if (!steps.some(s => s.id === source)) {
    throw new Error(`add-edge: source step "${source}" not found in plan (available: ${steps.map(s => s.id).join(', ')})`);
  }
  if (!steps.some(s => s.id === target)) {
    throw new Error(`add-edge: target step "${target}" not found in plan`);
  }
  const edges = plan.edges || [];
  if (edges.find(e => e.source === source && e.target === target)) {
    return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  }
  const edge = newEdge(source, target);
  const newPlan = { ...plan, edges: [...edges, edge], updatedAt: new Date().toISOString() };
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? newPlan : p) },
    inverse: { type: 'remove-edge', payload: { planId, edgeId: edge.id } }
  };
});

defineCommand('remove-edge', (ws, { planId, edgeId }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const plan = ws.plans[idx];
  const removed = plan.edges.find(e => e.id === edgeId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const newPlan = { ...plan, edges: plan.edges.filter(e => e.id !== edgeId), updatedAt: new Date().toISOString() };
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? newPlan : p) },
    inverse: { type: 'add-edge', payload: { planId, source: removed.source, target: removed.target } }
  };
});

defineCommand('add-mutex-group', (ws, { planId, stepIds, label }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) throw new Error(`add-mutex-group: no plan with id "${planId}"`);
  const plan = ws.plans[idx];
  if (!Array.isArray(stepIds) || stepIds.length < 2) {
    throw new Error(`add-mutex-group: stepIds must be an array of at least 2 step IDs (got ${JSON.stringify(stepIds)})`);
  }
  // Validate the IDs actually exist in the plan
  const validIds = stepIds.filter(id => (plan.steps || []).some(s => s.id === id));
  if (validIds.length < 2) {
    throw new Error(`add-mutex-group: not enough valid step IDs found in plan (got ${validIds.length} of ${stepIds.length})`);
  }
  const group = newMutexGroup(validIds, { label });
  const newPlan = { ...plan, mutexGroups: [...(plan.mutexGroups || []), group], updatedAt: new Date().toISOString() };
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? newPlan : p) },
    inverse: { type: 'remove-mutex-group', payload: { planId, groupId: group.id } }
  };
});

defineCommand('remove-mutex-group', (ws, { planId, groupId }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const plan = ws.plans[idx];
  const removed = plan.mutexGroups.find(g => g.id === groupId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const newPlan = { ...plan, mutexGroups: plan.mutexGroups.filter(g => g.id !== groupId), updatedAt: new Date().toISOString() };
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? newPlan : p) },
    inverse: { type: 'add-mutex-group', payload: { planId, stepIds: removed.stepIds, label: removed.label } }
  };
});

defineCommand('select-mutex-branch', (ws, { planId, groupId, stepId }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const plan = ws.plans[idx];
  const gIdx = plan.mutexGroups.findIndex(g => g.id === groupId);
  if (gIdx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const prev = plan.mutexGroups[gIdx].selectedStepId;
  const newGroups = plan.mutexGroups.map((g, i) => i === gIdx ? { ...g, selectedStepId: stepId } : g);
  const newPlan = { ...plan, mutexGroups: newGroups, updatedAt: new Date().toISOString() };
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? newPlan : p) },
    inverse: { type: 'select-mutex-branch', payload: { planId, groupId, stepId: prev } }
  };
});

defineCommand('log-execution', (ws, { entry }) => {
  const e = { ...newExecutionEntry(entry.stepRef), ...entry };
  return {
    workspace: { ...ws, executionLog: [...(ws.executionLog || []), e] },
    inverse: { type: 'remove-execution', payload: { entryId: e.id } }
  };
});

defineCommand('remove-execution', (ws, { entryId }) => {
  const removed = (ws.executionLog || []).find(e => e.id === entryId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  return {
    workspace: { ...ws, executionLog: ws.executionLog.filter(e => e.id !== entryId) },
    inverse: { type: 'log-execution', payload: { entry: removed } }
  };
});

defineCommand('start-conversation', (ws, { scope, ref }) => {
  const t = newConversation(scope, ref);
  return {
    workspace: { ...ws, conversations: [...(ws.conversations || []), t] },
    inverse: { type: 'remove-conversation', payload: { threadId: t.id } }
  };
});

defineCommand('remove-conversation', (ws, { threadId }) => {
  const removed = (ws.conversations || []).find(t => t.id === threadId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  return {
    workspace: { ...ws, conversations: ws.conversations.filter(t => t.id !== threadId) },
    inverse: { type: 'start-conversation', payload: { scope: removed.scope, ref: removed.ref } }
  };
});

defineCommand('append-message', (ws, { threadId, message }) => {
  const idx = (ws.conversations || []).findIndex(t => t.id === threadId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const m = { ...newMessage(message.role, message.content), ...message };
  const thread = ws.conversations[idx];
  const newThread = { ...thread, messages: [...(thread.messages || []), m] };
  return {
    workspace: { ...ws, conversations: ws.conversations.map((t, i) => i === idx ? newThread : t) },
    inverse: { type: 'pop-message', payload: { threadId } }
  };
});

defineCommand('pop-message', (ws, { threadId }) => {
  const idx = ws.conversations.findIndex(t => t.id === threadId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const thread = ws.conversations[idx];
  if (!thread.messages.length) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const removed = thread.messages[thread.messages.length - 1];
  const newThread = { ...thread, messages: thread.messages.slice(0, -1) };
  return {
    workspace: { ...ws, conversations: ws.conversations.map((t, i) => i === idx ? newThread : t) },
    inverse: { type: 'append-message', payload: { threadId, message: removed } }
  };
});

defineCommand('noop', (ws) => ({ workspace: ws, inverse: { type: 'noop', payload: {} } }));

// ============================================================================
// BATCH — apply a list of commands as one logical change (for AI proposals)
// ============================================================================

defineCommand('batch', (ws, { commands, label }) => {
  let workspace = ws;
  const inverses = [];
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const handler = registry.get(cmd.type);
    if (!handler) throw new Error(`Command ${i + 1}/${commands.length} (${cmd.type}): unknown command type`);
    try {
      const result = handler(workspace, cmd.payload);
      workspace = result.workspace;
      inverses.unshift(result.inverse);
    } catch (err) {
      throw new Error(`Command ${i + 1}/${commands.length} (${cmd.type}): ${err.message}`);
    }
  }
  return {
    workspace,
    inverse: { type: 'batch', payload: { commands: inverses, label: `Undo: ${label || 'batch'}` } }
  };
});
