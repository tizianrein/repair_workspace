/**
 * main.js — application entry point.
 *
 * Wires together state, views, AI endpoints, and user interactions. The two
 * core flows are:
 *
 *   1. CHAT (read-only):
 *      user types → POST /api/chat → reply rendered in bubble + optional
 *      suggestedAction button → if tapped, goes to PROPOSE flow.
 *
 *   2. PROPOSE (state-changing):
 *      quick-action chip OR chat suggestedAction → POST /api/propose →
 *      review modal → user accepts subset → batch command applied via
 *      apply(). One undo reverts the whole batch.
 *
 * Everything else (entity selection, scope changes, photo attach, mark-
 * complete, intent editing) is a state-mutating action that goes through
 * the same apply() pipeline.
 */

import { createState, subscribe, autoPersist, restore } from './core/state.js';
import { apply, undo, redo } from './core/commands.js';
import { migrateV1ToV2 } from './core/migrate.js';
import { newWorkspace, validateWorkspace, SCHEMA_VERSION } from './core/schema.js';
import { createViewer3D } from './views/viewer-3d.js';
import { createActionGraph } from './views/action-graph.js';
import { createSpatialGraph } from './views/spatial-graph.js';
import { createRadar } from './views/radar.js';
import { createEntityList } from './views/entity-list.js';
import { createChatSheet } from './views/chat-sheet.js';
import { createQuickActions } from './views/quick-actions.js';
import { createJustificationPanel } from './views/justification-panel.js';
import { showProposeReview } from './views/propose-review.js';
import { showExecutionEntry } from './views/execution-log.js';

const state = createState();
let viewer3D = null, actionGraph = null, spatialGraph = null;
let radar = null, entityList = null, chatSheet = null;
let quickActions = null, justificationPanel = null;
let activeTab = 'pane-3d';
let selectedStepId = null;
let proposeInFlight = false;

const $ = id => document.getElementById(id);
function log(msg) { $('console-output').textContent = msg; }

restore(state);
autoPersist(state);

// -------------------------------------------------------------------------
// View construction
// -------------------------------------------------------------------------

actionGraph = createActionGraph($('action-graph-canvas'), {
  onSelect: stepId => {
    selectedStepId = stepId;
    if (stepId) {
      justificationPanel.show(stepId);
      chatSheet.setScope('step', stepId);
    } else {
      justificationPanel.clear();
      chatSheet.setScope('global');
    }
    quickActions.render();
  },
  onDetail: stepId => openDetail({ type: 'step', id: stepId })
});

spatialGraph = createSpatialGraph($('spatial-graph-canvas'), {
  onDetail: target => openDetail(target)
});

radar = createRadar($('radar-canvas'), $('axis-list'), $('intent-summary'), {
  onChange: intent => apply(state, { type: 'set-intent', payload: { intent } })
});

entityList = createEntityList(
  $('entity-list'), $('entity-search'), $('entity-filter'),
  $('entity-count'), $('list-footer'),
  { onDetail: target => openDetail(target) }
);

chatSheet = createChatSheet(
  {
    history: $('chat-history'),
    input: $('chat-input'),
    sendBtn: $('chat-send'),
    scopePill: $('chat-scope'),
    titleEl: $('chat-title'),
    closeBtn: $('chat-close'),
    handle: $('chat-handle'),
    sheet: $('chat-sheet')
  },
  {
    getWorkspace: () => state.workspace,
    onScopeChange: () => quickActions?.render(),
    onProposeIntent: ({ userMessage, scope }) => runPropose({ userMessage, scope })
  }
);

quickActions = createQuickActions($('quick-actions'), {
  getScope: () => chatSheet.getCurrentScope(),
  getWorkspace: () => state.workspace,
  getCurrentMessage: () => chatSheet.getCurrentMessage(),
  onPropose: ({ scope, userMessage }) => runPropose({ scope, userMessage }),
  onMarkComplete: stepId => markStepComplete(stepId)
});

justificationPanel = createJustificationPanel($('justification-panel'), {
  getWorkspace: () => state.workspace,
  onJumpToHypothesis: hypId => {
    chatSheet.setScope('hypothesis', hypId);
    chatSheet.open();
    entityList.setSelection({ hypothesisId: hypId, partId: null });
    openDetail({ type: 'hypothesis', id: hypId });
  }
});

// -------------------------------------------------------------------------
// Render-all on state changes
// -------------------------------------------------------------------------

function renderAll() {
  const ws = state.workspace;
  $('object-name').value = ws.instance?.name || '';
  $('object-stats').textContent = `${ws.instance?.parts?.length || 0} parts · ${ws.hypotheses?.length || 0} hypotheses`;
  $('tools-available').value = ws.constraints?.tools_available || '';
  $('materials-available').value = ws.constraints?.materials_available || '';
  $('time-budget').value = ws.constraints?.time_budget_minutes || 0;
  $('budget-limit').value = ws.constraints?.budget_limit || '';
  $('skill-level').value = ws.constraints?.skill_level || 'intermediate';
  $('safety-level').value = ws.constraints?.safety_level || 'normal';
  $('allowed-ops').value = ws.constraints?.allowed_operations || '';
  $('avoid-ops').value = ws.constraints?.avoid_operations || '';
  $('additional-constraints').value = ws.constraints?.additional_constraints || '';

  radar.render(ws);
  entityList.render(ws);
  renderVersions(ws);
  quickActions.render();

  if (selectedStepId) {
    const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
    if (!plan?.steps?.find(s => s.id === selectedStepId)) {
      selectedStepId = null;
      justificationPanel.clear();
    } else {
      justificationPanel.show(selectedStepId);
    }
  }

  if (viewer3D && activeTab === 'pane-3d') viewer3D.render(ws);
  if (actionGraph && activeTab === 'pane-action') {
    actionGraph.render(ws);
    if (selectedStepId) actionGraph.setCurrentStep(selectedStepId);
  }
  if (spatialGraph && activeTab === 'pane-spatial') spatialGraph.render(ws);

  const hypCount = (ws.hypotheses || []).length;
  $('fab-right-badge').hidden = hypCount === 0;
  $('fab-right-badge').textContent = hypCount;
}

function renderVersions(ws) {
  const c = $('versions-list');
  const plans = ws.plans || [];
  if (!plans.length) { c.innerHTML = '<div class="entity-empty">No plans yet.</div>'; return; }
  c.innerHTML = '';
  [...plans].reverse().forEach(p => {
    const div = document.createElement('div');
    div.className = 'version-item' + (p.id === ws.currentPlanId ? ' current' : '');
    const time = new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.textContent = `${p.label} · ${p.status} · ${time}`;
    div.onclick = () => apply(state, { type: 'set-current-plan', payload: { planId: p.id } });
    c.appendChild(div);
  });
}

subscribe(state, renderAll);

// -------------------------------------------------------------------------
// Tabs
// -------------------------------------------------------------------------

document.querySelectorAll('.tab').forEach(t => { t.onclick = () => switchTab(t.dataset.pane); });

function switchTab(paneId) {
  activeTab = paneId;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.pane === paneId));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === paneId));
  if (paneId === 'pane-3d' && !viewer3D) {
    viewer3D = createViewer3D(
      $('viewer-canvas'),
      $('info-box'),
      target => { if (target) openDetail({ type: target.type, id: target.data.id }); }
    );
    $('explode-btn').onclick = () => viewer3D.explode();
    $('restore-btn').onclick = () => viewer3D.restore();
    viewer3D.render(state.workspace);
    setTimeout(() => viewer3D.resize(), 50);
  } else if (paneId === 'pane-3d' && viewer3D) {
    viewer3D.render(state.workspace);
    setTimeout(() => viewer3D.resize(), 50);
  } else if (paneId === 'pane-action') {
    actionGraph.render(state.workspace);
    if (selectedStepId) actionGraph.setCurrentStep(selectedStepId);
    setTimeout(() => actionGraph.resize(), 50);
  } else if (paneId === 'pane-spatial') {
    spatialGraph.render(state.workspace);
    setTimeout(() => spatialGraph.resize(), 50);
  }
}

$('action-fit').onclick = () => actionGraph.fit();
$('spatial-fit').onclick = () => spatialGraph.fit();

// -------------------------------------------------------------------------
// FABs, drawers
// -------------------------------------------------------------------------

$('fab-left').onclick = () => toggleDrawer('left');
$('fab-right').onclick = () => toggleDrawer('right');
$('fab-chat').onclick = () => chatSheet.isOpen() ? chatSheet.close() : chatSheet.open();
$('backdrop').onclick = () => { closeDrawer('left'); closeDrawer('right'); };
document.querySelectorAll('.drawer-close').forEach(b => { b.onclick = () => closeDrawer(b.dataset.close); });

function toggleDrawer(side) {
  document.body.classList.toggle(`${side}-open`);
  if (side === 'left') document.body.classList.remove('right-open');
  if (side === 'right') document.body.classList.remove('left-open');
}
function closeDrawer(side) { document.body.classList.remove(`${side}-open`); }

document.querySelectorAll('[data-toggle]').forEach(t => {
  t.onclick = () => $(t.dataset.toggle).classList.toggle('collapsed');
});

// -------------------------------------------------------------------------
// Left-drawer field bindings
// -------------------------------------------------------------------------

$('object-name').addEventListener('change', e => {
  apply(state, { type: 'set-object-name', payload: { name: e.target.value.trim() } });
});

['tools-available','materials-available','budget-limit','allowed-ops','avoid-ops','additional-constraints'].forEach(id => {
  $(id).addEventListener('change', e => {
    const key = ({
      'tools-available': 'tools_available',
      'materials-available': 'materials_available',
      'budget-limit': 'budget_limit',
      'allowed-ops': 'allowed_operations',
      'avoid-ops': 'avoid_operations',
      'additional-constraints': 'additional_constraints'
    })[id];
    apply(state, { type: 'set-constraints', payload: { constraints: { [key]: e.target.value } } });
  });
});
$('time-budget').addEventListener('change', e => {
  apply(state, { type: 'set-constraints', payload: { constraints: { time_budget_minutes: Number(e.target.value || 0) } } });
});
$('skill-level').addEventListener('change', e => {
  apply(state, { type: 'set-constraints', payload: { constraints: { skill_level: e.target.value } } });
});
$('safety-level').addEventListener('change', e => {
  apply(state, { type: 'set-constraints', payload: { constraints: { safety_level: e.target.value } } });
});
$('add-axis-btn').onclick = () => radar.addAxis();
$('reset-intent-btn').onclick = () => {
  const fresh = newWorkspace().intent;
  apply(state, { type: 'set-intent', payload: { intent: fresh } });
};

// -------------------------------------------------------------------------
// Workspace JSON load / save / example / reset
// -------------------------------------------------------------------------

$('load-workspace-btn').onclick = () => $('workspace-file').click();
$('workspace-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    loadWorkspaceJson(JSON.parse(text));
    log(`Loaded ${file.name}`);
  } catch (err) {
    log(`Load failed: ${err.message}`);
  }
});

function loadWorkspaceJson(parsed) {
  let ws;
  if (parsed.schemaVersion === SCHEMA_VERSION) {
    ws = parsed;
  } else {
    const { workspace: migrated, warnings } = migrateV1ToV2(parsed);
    ws = migrated;
    if (warnings.length) { console.warn('Migration warnings:', warnings); log(`Migrated (${warnings.length} warnings — see console)`); }
  }
  const v = validateWorkspace(ws);
  if (!v.ok) { log(`Validation failed: ${v.errors[0]}`); return; }
  state.workspace = ws;
  state.history = [];
  state.future = [];
  selectedStepId = null;
  state.listeners.forEach(fn => fn(ws, { type: 'load-workspace' }));
}

$('download-state-btn').onclick = () => {
  const blob = new Blob([JSON.stringify(state.workspace, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.workspace.instance?.name || 'repair-workspace') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
};

$('load-example-btn').onclick = async () => {
  try {
    const res = await fetch('/examples/old-wooden-door/workspace.json');
    if (!res.ok) throw new Error(`Example not found (${res.status})`);
    loadWorkspaceJson(await res.json());
    log('Loaded example: old wooden door');
  } catch (err) {
    log(`Example load failed: ${err.message}`);
  }
};

$('reset-btn').onclick = () => {
  if (!confirm('Reset workspace? This clears all parts, hypotheses, and plans.')) return;
  state.workspace = newWorkspace();
  state.history = [];
  state.future = [];
  selectedStepId = null;
  state.listeners.forEach(fn => fn(state.workspace, { type: 'reset' }));
  log('Workspace reset.');
};

// -------------------------------------------------------------------------
// Photo attachment for chat
// -------------------------------------------------------------------------

$('chat-camera-btn').onclick = () => $('chat-photo-file').click();
$('chat-photo-file').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  for (const file of files) {
    try {
      const data = await fileToBase64(file);
      chatSheet.attachPhoto({ name: file.name, mimeType: file.type || 'image/jpeg', data });
    } catch (err) {
      log(`Photo read failed: ${err.message}`);
    }
  }
  e.target.value = '';
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('read error'));
    r.readAsDataURL(file);
  });
}

// -------------------------------------------------------------------------
// Detail modal
// -------------------------------------------------------------------------

document.querySelectorAll('[data-close-modal]').forEach(b => {
  b.onclick = () => $(b.dataset.closeModal).classList.remove('on');
});

function openDetail(target) {
  if (!target) return;
  const ws = state.workspace;
  let title = '', entries = [];
  if (target.type === 'part') {
    const p = (ws.instance?.parts || []).find(x => x.id === target.id);
    if (!p) return;
    const d = p.dimensions || {};
    const w = Math.round((d.width || 0) * 1000) / 10;
    const h = Math.round((d.height || 0) * 1000) / 10;
    const dp = Math.round((d.depth || 0) * 1000) / 10;
    const hyps = (ws.hypotheses || []).filter(x => x.partRef === target.id);
    title = `Part: ${p.id}`;
    entries = [
      ['Status', p.status || 'intact'],
      ['Material', p.material || '—'],
      ['Dimensions', `${w} × ${h} × ${dp} cm`],
      ['Connections', (p.connections || []).join(', ') || '—'],
      ['Hypotheses', hyps.length ? hyps.map(h => `${h.type} (${h.status})`).join(', ') : 'none']
    ];
    if (viewer3D) viewer3D.select({ partId: p.id });
    entityList.setSelection({ partId: p.id, hypothesisId: null });
    chatSheet.setScope('part', p.id);
  } else if (target.type === 'hypothesis') {
    const h = (ws.hypotheses || []).find(x => x.id === target.id);
    if (!h) return;
    title = `Hypothesis: ${h.id}`;
    entries = [
      ['Type', h.type || '—'],
      ['Status', h.status],
      ['Confidence', `${Math.round((h.confidence ?? 0) * 100)}%`],
      ['Part', h.partRef || '—'],
      ['Description', h.description || '—']
    ];
    if (viewer3D) viewer3D.select({ hypothesisId: h.id, partId: h.partRef });
    entityList.setSelection({ partId: null, hypothesisId: h.id });
    chatSheet.setScope('hypothesis', h.id);
  } else if (target.type === 'step') {
    const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
    const s = plan?.steps?.find(x => x.id === target.id);
    if (!s) return;
    title = `Step: ${s.title || s.id}`;
    entries = [
      ['Status', s.status],
      ['Confidence', `${Math.round((s.confidence ?? 0) * 100)}%`],
      ['Affects parts', (s.affectedPartRefs || []).join(', ') || '—'],
      ['Addresses', (s.addressesHypothesisRefs || []).join(', ') || '—'],
      ['Tools', (s.toolsRequired || []).join(', ') || '—'],
      ['Materials', (s.materialsRequired || []).join(', ') || '—'],
      ['Estimated', s.estimatedMinutes ? `${s.estimatedMinutes} min` : '—'],
      ['Expected outcome', s.expectedOutcome || '—'],
      ['Description', s.description || '—'],
      ['Rationale', s.justification?.rationale || '—']
    ];
    selectedStepId = target.id;
    actionGraph.setCurrentStep(target.id);
    justificationPanel.show(target.id);
    chatSheet.setScope('step', target.id);
  }
  $('detail-title').textContent = title;
  $('detail-grid').innerHTML = entries.map(([l, v]) =>
    `<div class="detail-box"><div class="label">${escapeHtml(l)}</div><div class="value">${escapeHtml(v)}</div></div>`
  ).join('');
  $('detail-modal').classList.add('on');
  quickActions.render();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// -------------------------------------------------------------------------
// PROPOSE — the AI-state-change flow
// -------------------------------------------------------------------------

async function runPropose({ scope = 'all', userMessage }) {
  if (proposeInFlight) { log('A proposal is already in progress…'); return; }
  if (!userMessage || !userMessage.trim()) {
    log('Type a message or use the chat to describe what you want.');
    chatSheet.open();
    return;
  }
  proposeInFlight = true;
  chatSheet.setBusy(true);
  log(`Asking the AI to propose changes (${scope})…`);

  // Record the user-side action in the chat thread so it's findable later
  chatSheet.pushMessage('user', userMessage);
  chatSheet.open();

  // Show a thinking placeholder bubble inline
  const thinking = document.createElement('div');
  thinking.className = 'chat-bubble chat-llm chat-thinking';
  thinking.textContent = `Proposing changes (${scope})…`;
  $('chat-history').appendChild(thinking);
  $('chat-history').scrollTop = $('chat-history').scrollHeight;

  try {
    const res = await fetch('/api/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope,
        userMessage,
        workspace: state.workspace
      })
    });
    thinking.remove();
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      log(`Propose failed: ${err.error || res.status}`);
      chatSheet.pushMessage('assistant', `Proposal failed: ${err.error || res.status}`);
      return;
    }
    const payload = await res.json();
    const totalCount = (payload.commands || []).length;

    // Record the summary in chat BEFORE the modal opens — so it's preserved
    // whether the user accepts, rejects, or just closes the modal
    chatSheet.pushMessage('assistant', payload.summary || `(${totalCount} change${totalCount === 1 ? '' : 's'} proposed — see modal)`);

    const accepted = await showProposeReview({
      summary: payload.summary,
      commands: payload.commands || []
    });

    if (!accepted) {
      chatSheet.pushActionRecord(`✕ Proposal rejected (${totalCount} change${totalCount === 1 ? '' : 's'})`);
      log('Proposal rejected.');
      return;
    }
    if (!accepted.length) {
      chatSheet.pushActionRecord(`✕ Nothing applied (${totalCount} change${totalCount === 1 ? '' : 's'} unchecked)`);
      log('Proposal had no items selected.');
      return;
    }
    apply(state, {
      type: 'batch',
      payload: {
        label: `AI: ${payload.summary?.slice(0, 60) || 'changes'}`,
        commands: accepted
      }
    });
    const skipped = totalCount - accepted.length;
    const tag = skipped > 0
      ? `✓ Applied ${accepted.length} of ${totalCount} changes (${skipped} skipped)`
      : `✓ Applied ${accepted.length} change${accepted.length === 1 ? '' : 's'}`;
    chatSheet.pushActionRecord(tag);
    log(`Applied ${accepted.length} change${accepted.length === 1 ? '' : 's'}.`);
    chatSheet.setMessage('');
  } catch (err) {
    log(`Propose error: ${err.message}`);
    chatSheet.pushMessage('assistant', `Error during proposal: ${err.message}`);
  } finally {
    proposeInFlight = false;
    chatSheet.setBusy(false);
  }
}

// -------------------------------------------------------------------------
// Mark step complete — opens the execution log modal
// -------------------------------------------------------------------------

async function markStepComplete(stepId) {
  const ws = state.workspace;
  const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
  const step = plan?.steps?.find(s => s.id === stepId);
  if (!step) { log('Step not found.'); return; }
  const entry = await showExecutionEntry(step);
  if (!entry) return;
  apply(state, {
    type: 'batch',
    payload: {
      label: `Completed: ${step.title || step.id}`,
      commands: [
        { type: 'log-execution', payload: { entry } },
        { type: 'upsert-step', payload: { planId: plan.id, step: { ...step, status: 'completed' } } }
      ]
    }
  });
  log(`Marked "${step.title || step.id}" complete.`);

  // Record in chat
  const stepLabel = step.title || step.id;
  const timePart = entry.actualDurationMinutes ? ` · ${entry.actualDurationMinutes} min` : '';
  let record = `✓ Completed "${stepLabel}"${timePart}`;
  if (entry.outcome && entry.outcome !== 'as-planned') {
    record += ` · ${entry.outcome}`;
    if (entry.deviation) record += `: ${entry.deviation}`;
  }
  chatSheet.pushActionRecord(record);
}

// -------------------------------------------------------------------------
// Keyboard shortcuts and resize
// -------------------------------------------------------------------------

window.addEventListener('resize', () => {
  if (viewer3D) viewer3D.resize();
  if (actionGraph) actionGraph.resize();
  if (spatialGraph) spatialGraph.resize();
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault(); undo(state); log('Undo');
  } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault(); redo(state); log('Redo');
  }
});

renderAll();
chatSheet.setScope('global');
log('Workspace ready.');
