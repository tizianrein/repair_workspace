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
  newExecutionEntry, newConversation, newMessage
} from './schema.js';

const registry = new Map();

export function defineCommand(type, handler) { registry.set(type, handler); }

export function apply(state, command) {
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
  state.history.push(recorded);
  state.future = [];
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
  const next = idx >= 0
    ? parts.map((p, i) => i === idx ? part : p)
    : [...parts, part];
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

defineCommand('set-intent', (ws, { intent }) => {
  const prev = ws.intent;
  return {
    workspace: { ...ws, intent: { ...prev, ...intent } },
    inverse: { type: 'set-intent', payload: { intent: prev } }
  };
});

defineCommand('set-constraints', (ws, { constraints }) => {
  const prev = ws.constraints;
  return {
    workspace: { ...ws, constraints: { ...prev, ...constraints } },
    inverse: { type: 'set-constraints', payload: { constraints: prev } }
  };
});

defineCommand('add-plan', (ws, { plan }) => {
  const p = { ...newPlan(), ...plan };
  return {
    workspace: { ...ws, plans: [...(ws.plans || []), p], currentPlanId: p.id },
    inverse: { type: 'remove-plan', payload: { planId: p.id } }
  };
});

defineCommand('remove-plan', (ws, { planId }) => {
  const removed = ws.plans.find(p => p.id === planId);
  if (!removed) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const currentPlanId = ws.currentPlanId === planId ? null : ws.currentPlanId;
  return {
    workspace: { ...ws, plans: ws.plans.filter(p => p.id !== planId), currentPlanId },
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

defineCommand('set-plan-status', (ws, { planId, status }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) return { workspace: ws, inverse: { type: 'noop', payload: {} } };
  const prev = ws.plans[idx].status;
  return {
    workspace: { ...ws, plans: ws.plans.map((p, i) => i === idx ? { ...p, status, updatedAt: new Date().toISOString() } : p) },
    inverse: { type: 'set-plan-status', payload: { planId, status: prev } }
  };
});

defineCommand('upsert-step', (ws, { planId, step }) => {
  const idx = ws.plans.findIndex(p => p.id === planId);
  if (idx < 0) throw new Error(`upsert-step: no plan with id "${planId}" — make sure add-plan created it first, and that the planId matches`);
  const plan = ws.plans[idx];
  const planSteps = plan.steps || [];
  const stepIdx = planSteps.findIndex(s => s.id === step.id);
  const prev = stepIdx >= 0 ? planSteps[stepIdx] : null;
  const fullStep = { ...newStep(), ...step };
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
