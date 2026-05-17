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
import { newWorkspace, validateWorkspace, SCHEMA_VERSION, newEvidence, newHypothesis,
         newIntent, getCurrentPlan, getCurrentIntent, getCurrentConstraints } from './core/schema.js';
import { PhotoStorage } from './core/photo-storage.js';
import { compressImage, blobToBase64, formatBytes } from './core/image-compress.js';
import { exportWorkspaceBundle, importWorkspaceBundle, downloadBlob } from './core/workspace-bundle.js';
import { createViewer3D } from './views/viewer-3d.js';
import { createActionGraph } from './views/action-graph.js';
import { createSpatialGraph } from './views/spatial-graph.js';
import { createRadar } from './views/radar.js';
import { createEntityList } from './views/entity-list.js';
import { createChatSheet } from './views/chat-sheet.js';
import { createQuickActions } from './views/quick-actions.js';
import { showProposeReview } from './views/propose-review.js';
import { showExecutionEntry } from './views/execution-log.js';
import { createDetailEditor } from './views/detail-editor.js';
import { payloadForPropose } from './ai/ai-payload.js';

const state = createState();
let viewer3D = null, actionGraph = null, spatialGraph = null;
let radar = null, entityList = null, chatSheet = null;
let quickActions = null;
let activeTab = 'pane-3d';
let selectedStepId = null;
let proposeInFlight = false;
let viewerDirty = {};

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
      chatSheet.setScope('step', stepId);
      // Single tap opens the detail modal directly — replaces the older
      // "click for justification panel, double-click for full detail"
      // discovery problem with one consistent action.
      openDetail({ type: 'step', id: stepId });
    } else {
      // Full reset matching the 3D background-click behaviour
      entityList.setSelection({ partId: null, hypothesisId: null });
      if (viewer3D) viewer3D.select({ partId: null, hypothesisId: null });
      chatSheet.setScope('global');
    }
    quickActions.render();
  },
  onDetail: stepId => openDetail({ type: 'step', id: stepId })
});

spatialGraph = createSpatialGraph($('spatial-graph-canvas'), {
  onDetail: target => openDetail(target),
  onBackgroundTap: () => {
    entityList.setSelection({ partId: null, hypothesisId: null });
    if (viewer3D) viewer3D.select({ partId: null, hypothesisId: null });
    selectedStepId = null;
    chatSheet.setScope('global');
    quickActions.render();
  }
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
    onProposeIntent: ({ userMessage, scope }) => runPropose({ userMessage, scope }),
    // Persist conversations through the command system. Without these,
    // chat threads are transient JS objects that disappear the next
    // time the workspace re-renders — which is what caused chat
    // history to silently vanish on scope switch.
    onEnsureThread: ({ scope, ref }) => {
      apply(state, { type: 'start-conversation', payload: { scope, ref } }, { skipHistory: true });
    },
    onAppendMessage: ({ threadId, message }) => {
      apply(state, { type: 'append-message', payload: { threadId, message } }, { skipHistory: true });
    },
    // Apply AI tool-call commands as a single undoable batch so the user
    // can Ctrl+Z the whole conversational change in one go.
    onApplyCommands: ({ commands, summary }) => {
      if (!Array.isArray(commands) || commands.length === 0) return;
      apply(state, {
        type: 'batch',
        payload: {
          commands,
          label: `AI: ${summary || (commands.length + ' changes')}`
        }
      });
    }
  }
);

quickActions = createQuickActions($('quick-actions'), {
  getScope: () => chatSheet.getCurrentScope(),
  getWorkspace: () => state.workspace,
  getCurrentMessage: () => chatSheet.getCurrentMessage(),
  onPropose: ({ scope, userMessage }) => runPropose({ scope, userMessage }),
  onMarkComplete: stepId => markStepComplete(stepId)
});

viewer3D = createViewer3D(
  $('viewer-canvas'),
  $('info-box'),
  target => {
    if (target) {
      openDetail({ type: target.type, id: target.data.id });
    } else {
      // Background click → clear selection, return to global chat scope
      entityList.setSelection({ partId: null, hypothesisId: null });
      chatSheet.setScope('global');
      quickActions.render();
    }
  }
);
$('explode-btn').onclick = () => {
  viewer3D.toggleExplode();
  $('explode-btn').textContent = viewer3D.isExploded() ? '↩️' : '💥';
  $('explode-btn').title = viewer3D.isExploded() ? 'Restore view' : 'Explode view';
};

// Display-mode toggle for the textured-mesh overlay. Lives in the
// Data section of the left sidebar. Cycles boxes → mesh → both →
// boxes. Hidden unless a mesh is actually loaded into the viewer.
function syncDisplayModeBtn() {
  const btn = $('display-mode-btn');
  if (!btn) return;
  if (!viewer3D || !viewer3D.hasMesh()) { btn.hidden = true; return; }
  btn.hidden = false;
  const mode = viewer3D.getDisplayMode();
  // Label is "Showing X · click for Y" — explicit because the sidebar
  // has room, and because users don't always remember what the icons
  // mean. The leading glyph mirrors what the viewer is currently
  // displaying so it doubles as a state indicator.
  if (mode === 'both')        { btn.textContent = '🟰 Showing both · click for mesh'; }
  else if (mode === 'mesh')   { btn.textContent = '🧊 Showing mesh · click for boxes'; }
  else                        { btn.textContent = '📦 Showing boxes · click for both'; }
}
$('display-mode-btn').onclick = () => {
  if (!viewer3D || !viewer3D.hasMesh()) return;
  const mode = viewer3D.getDisplayMode();
  const next = mode === 'both' ? 'mesh' : mode === 'mesh' ? 'boxes' : 'both';
  viewer3D.setDisplayMode(next);
  syncDisplayModeBtn();
};

// -------------------------------------------------------------------------
// Manual "place new condition" mode
//
// Entry: user clicks "+ New condition" in the right drawer.
// Flow:
//   1. Switch to Proxy/3D tab (if not already)
//   2. Activate place mode in viewer-3d → crosshair cursor, banner appears
//   3. User clicks on a part in the 3D view
//   4. We dispatch add-hypothesis with partRef + world coordinates
//   5. Exit place mode, then open the detail editor on the new hypothesis
//      so the user can fill in type, description, status, attach photos.
// Cancel: Esc, or click the Cancel button in the banner, or click the
//   "+ New condition" button again (toggle).
// -------------------------------------------------------------------------

let inPlaceMode = false;

function enterPlaceMode() {
  if (inPlaceMode) return;
  const ws = state.workspace;
  if (!ws.instance?.parts?.length) {
    log('No parts to attach a condition to. Load an artefact first.');
    return;
  }
  // Make sure we're on the 3D tab
  if (activeTab !== 'pane-3d') {
    const tab = document.querySelector('[data-tab="pane-3d"]');
    if (tab) tab.click();
  }
  inPlaceMode = true;
  $('place-banner').hidden = false;
  $('new-condition-btn').classList.add('active');
  $('new-condition-btn').textContent = '✕ Cancel placement';
  if (viewer3D) {
    viewer3D.setPlaceMode(true, ({ part, point }) => {
      // Build the new condition with sensible defaults
      const newHyp = newHypothesis({
        type: 'New condition',
        description: '',
        partRef: part.id,
        coordinates: { x: point.x, y: point.y, z: point.z },
        status: 'suspected',
        confidence: 0.5
      });
      apply(state, { type: 'add-hypothesis', payload: { hypothesis: newHyp } });
      exitPlaceMode();
      log(`Added new condition on ${part.id}. Edit it below.`);
      // Open the detail editor on the new hypothesis so the user can fill it in
      openDetail({ type: 'hypothesis', id: newHyp.id });
    });
  }
}

function exitPlaceMode() {
  if (!inPlaceMode) return;
  inPlaceMode = false;
  $('place-banner').hidden = true;
  $('new-condition-btn').classList.remove('active');
  $('new-condition-btn').textContent = '+ New condition';
  if (viewer3D) viewer3D.setPlaceMode(false);
}

$('new-condition-btn').onclick = () => {
  if (inPlaceMode) exitPlaceMode();
  else enterPlaceMode();
};

$('place-cancel-btn').onclick = exitPlaceMode;

// Escape exits place mode
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && inPlaceMode) {
    e.preventDefault();
    exitPlaceMode();
  }
});



function renderAll() {
  const ws = state.workspace;
  $('object-name').value = ws.instance?.name || '';
  $('object-stats').textContent = `${ws.instance?.parts?.length || 0} parts · ${ws.hypotheses?.length || 0} hypotheses`;
  // Constraints are per-strategy. Read from the current plan; getCurrentConstraints
  // falls back to defaults if no plan is current yet (empty workspace).
  const cons = getCurrentConstraints(ws);
  $('tools-available').value = cons.tools_available || '';
  $('materials-available').value = cons.materials_available || '';
  $('time-budget').value = cons.time_budget_minutes || 0;
  $('budget-limit').value = cons.budget_limit || '';
  $('skill-level').value = cons.skill_level || 'intermediate';
  $('safety-level').value = cons.safety_level || 'normal';
  $('allowed-ops').value = cons.allowed_operations || '';
  $('avoid-ops').value = cons.avoid_operations || '';
  $('additional-constraints').value = cons.additional_constraints || '';

  radar.render(ws);
  entityList.render(ws);
  renderStrategies(ws);
  renderImagineSection(ws);
  renderCover(ws);
  quickActions.render();

  if (selectedStepId) {
    const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
    if (!plan?.steps?.find(s => s.id === selectedStepId)) {
      selectedStepId = null;
    }
  }

  const dirty = { 'pane-3d': true, 'pane-action': true, 'pane-spatial': true };
  delete dirty[activeTab];
  viewerDirty = dirty;

  if (viewer3D && activeTab === 'pane-3d') viewer3D.render(ws);
  if (actionGraph && activeTab === 'pane-action') {
    actionGraph.render(ws);
    if (selectedStepId) actionGraph.setCurrentStep(selectedStepId);
  }
  if (spatialGraph && activeTab === 'pane-spatial') spatialGraph.render(ws);

  // Re-render the detail modal if open so edits reflect in modal contents.
  // The detail editor itself skips destroying the mini-viewer when the
  // target hasn't changed, so the camera position is preserved.
  if (lastDetailTarget && $('detail-modal')?.classList.contains('on')) {
    detailEditor.open(lastDetailTarget, { preserveViewer: true });
  }

  const hypCount = (ws.hypotheses || []).length;
  $('fab-right-badge').hidden = hypCount === 0;
  $('fab-right-badge').textContent = hypCount;

  // 3D empty-state hint: shown when no parts at all (fresh workspace
  // before example is loaded or assembly is extracted).
  const partsCount = ws.instance?.parts?.length || 0;
  const emptyEl = document.getElementById('viewer-empty');
  if (emptyEl) emptyEl.hidden = partsCount > 0;
}

function renderStrategies(ws) {
  const c = $('versions-list');
  const plans = ws.plans || [];
  if (!plans.length) {
    c.innerHTML = '<div class="entity-empty">No strategies yet. Create one to start planning.</div>';
    return;
  }
  c.innerHTML = '';
  // Newest first, matching the previous behaviour.
  [...plans].reverse().forEach(p => {
    const div = document.createElement('div');
    const isCurrent = p.id === ws.currentPlanId;
    div.className = 'strategy-item' + (isCurrent ? ' current' : '');
    // Color shows on a left border. Set as a CSS custom property so
    // hover/current state can shade it consistently.
    if (p.color) div.style.setProperty('--strategy-color', p.color);

    const time = new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const stepCount = (p.steps || []).length;
    const label = escapeAttr(p.label || 'Untitled strategy');

    div.innerHTML = `
      <div class="strategy-main">
        <div class="strategy-label" title="${label}">${label}</div>
        <div class="strategy-meta">${p.status} · ${stepCount} step${stepCount === 1 ? '' : 's'} · ${time}</div>
      </div>
      <div class="strategy-actions">
        <button class="strategy-action" data-act="export" title="Export this strategy as JSON">⤓</button>
        <button class="strategy-action" data-act="delete" title="Delete this strategy">✕</button>
      </div>
    `;

    // Click the main body → switch strategy. Action buttons handle their
    // own events and stop propagation so they don't also fire the switch.
    div.querySelector('.strategy-main').onclick = () => {
      if (!isCurrent) apply(state, { type: 'set-current-plan', payload: { planId: p.id } });
    };
    div.querySelector('[data-act="export"]').onclick = (e) => {
      e.stopPropagation();
      exportStrategy(p.id);
    };
    div.querySelector('[data-act="delete"]').onclick = (e) => {
      e.stopPropagation();
      const ok = confirm(`Delete strategy "${p.label}"?\n\nThis only removes the strategy. The artefact, hypotheses, and evidence are not affected.`);
      if (ok) apply(state, { type: 'remove-plan', payload: { planId: p.id } });
    };
    c.appendChild(div);
  });
}

// Small HTML attribute escaper used in the template above. Strategy
// labels can contain arbitrary user text.
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Build a workspace JSON containing the artefact + just this one
// strategy, then trigger a download. Renderings attached to other
// strategies are omitted (smaller file, less leakage). Images stay in
// IndexedDB on the original device; the receiver would need the
// bundled-with-photos export for full portability — that's still done
// via the main Save JSON button.
function exportStrategy(planId) {
  const ws = state.workspace;
  const plan = (ws.plans || []).find(p => p.id === planId);
  if (!plan) return;
  const trimmed = {
    ...ws,
    plans: [plan],
    currentPlanId: plan.id,
    evidence: (ws.evidence || []).filter(e => e.kind !== 'rendering' || e.planRef === planId)
  };
  const safeLabel = (plan.label || 'strategy').replace(/[^a-z0-9-_]+/gi, '_');
  const fileName = `${ws.instance?.name || 'workspace'}__${safeLabel}.json`;
  const blob = new Blob([JSON.stringify(trimmed, null, 2)], { type: 'application/json' });
  downloadBlob(blob, fileName);
  log(`Exported strategy "${plan.label}".`);
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

  const isDirty = viewerDirty[paneId];
  delete viewerDirty[paneId];

  if (paneId === 'pane-3d' && !viewer3D) {
    viewer3D = createViewer3D(
      $('viewer-canvas'),
      $('info-box'),
      target => {
        if (target) {
          openDetail({ type: target.type, id: target.data.id });
        } else {
          entityList.setSelection({ partId: null, hypothesisId: null });
          chatSheet.setScope('global');
          quickActions.render();
        }
      }
    );
    $('explode-btn').onclick = () => {
      viewer3D.toggleExplode();
      $('explode-btn').textContent = viewer3D.isExploded() ? '↩️' : '💥';
      $('explode-btn').title = viewer3D.isExploded() ? 'Restore view' : 'Explode view';
    };
    viewer3D.render(state.workspace);
    setTimeout(() => viewer3D.resize(), 50);
  } else if (paneId === 'pane-3d' && viewer3D) {
    if (isDirty) viewer3D.render(state.workspace);
    setTimeout(() => viewer3D.resize(), 50);
  } else if (paneId === 'pane-action') {
    if (isDirty) {
      actionGraph.render(state.workspace);
      if (selectedStepId) actionGraph.setCurrentStep(selectedStepId);
    }
    setTimeout(() => actionGraph.resize(), 50);
  } else if (paneId === 'pane-spatial') {
    if (isDirty) spatialGraph.render(state.workspace);
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
  apply(state, { type: 'set-intent', payload: { intent: newIntent() } });
};

// Strategies: + New blank starts an empty plan on the same artefact;
// + Duplicate current copies the current strategy (intent, constraints,
// steps, edges, mutex groups, and any imagined-result renderings).
$('new-strategy-btn').onclick = () => {
  const ws = state.workspace;
  const n = (ws.plans || []).length + 1;
  apply(state, {
    type: 'add-plan',
    payload: { plan: { label: `Strategy ${n}` } }
  });
};

$('duplicate-strategy-btn').onclick = () => {
  const ws = state.workspace;
  const cur = getCurrentPlan(ws);
  if (!cur) {
    // Nothing to duplicate yet — behave like + New blank.
    $('new-strategy-btn').click();
    return;
  }
  apply(state, {
    type: 'duplicate-plan',
    payload: { sourcePlanId: cur.id }
  });
};

// -------------------------------------------------------------------------
// Workspace JSON load / save / example / reset
// -------------------------------------------------------------------------

$('load-workspace-btn').onclick = () => $('workspace-file').click();
$('workspace-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { workspace: parsed, photoCount } = await importWorkspaceBundle(file);
    loadWorkspaceJson(parsed);
    log(`Loaded ${file.name}${photoCount ? ` (+ ${photoCount} photos)` : ''}`);
  } catch (err) {
    console.error(err);
    log(`Load failed: ${err.message}`);
  }
  e.target.value = '';
});

function loadWorkspaceJson(parsed) {
  // Any non-example load drops the previous example's mesh overlay and
  // forgets its slug. The example-load handler re-attaches them after
  // calling this — ordering matters.
  if (viewer3D) viewer3D.clearMesh();
  forgetExampleSlug();
  syncDisplayModeBtn();

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
  // Reset chat to global scope and pick up any seeded conversation in the
  // freshly loaded workspace.
  chatSheet.setScope('global');
  chatSheet.refresh();
}

$('download-state-btn').onclick = async () => {
  try {
    const photoCount = (state.workspace.evidence || []).filter(e => e.kind === 'photo').length;
    if (photoCount === 0) {
      // No photos — plain JSON is friendlier
      const blob = new Blob([JSON.stringify(state.workspace, null, 2)], { type: 'application/json' });
      downloadBlob(blob, (state.workspace.instance?.name || 'workspace') + '.json');
      log('Saved JSON (no photos).');
      return;
    }
    log(`Bundling workspace with ${photoCount} photo${photoCount === 1 ? '' : 's'}…`);
    const { blob, photoCount: included } = await exportWorkspaceBundle(state.workspace);
    downloadBlob(blob, (state.workspace.instance?.name || 'workspace') + '.zip');
    log(`Saved ZIP with ${included} photo${included === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error(err);
    log(`Save failed: ${err.message}`);
  }
};

$('load-example-select').onchange = async (e) => {
  const slug = e.target.value;
  if (!slug) return;
  try {
    const res = await fetch(`/examples/${slug}/workspace.json`);
    if (!res.ok) throw new Error(`Example not found (${res.status})`);
    loadWorkspaceJson(await res.json());
    // Cover (persisted on workspace) + mesh.glb (transient, slug
    // remembered in localStorage so reload can re-fetch).
    await attachExampleAssets(slug);
    log(`Loaded example: ${slug}`);
  } catch (err) {
    console.error(err);
    log(`Example load failed: ${err.message}`);
  } finally {
    e.target.value = '';
  }
};

// Populate the example dropdown from /examples/manifest.json which is
// auto-generated at dev/build time by the Vite plugin in vite.config.js.
// Dropping a new folder into src/public/examples/ is enough — no code
// change needed for it to show up.
(async function populateExamples() {
  try {
    const res = await fetch('/examples/manifest.json');
    if (!res.ok) {
      console.warn('No examples manifest found');
      return;
    }
    const { examples } = await res.json();
    const select = $('load-example-select');
    for (const ex of (examples || [])) {
      const opt = document.createElement('option');
      opt.value = ex.slug;
      opt.textContent = ex.description
        ? `${ex.name} — ${ex.description}`
        : ex.name;
      select.appendChild(opt);
    }
  } catch (err) {
    console.warn('Examples manifest load failed:', err);
  }
})();

$('reset-btn').onclick = () => {
  if (!confirm('Reset workspace? This clears all parts, hypotheses, and plans.')) return;
  state.workspace = newWorkspace();
  state.history = [];
  state.future = [];
  selectedStepId = null;
  // Resetting drops the example association: mesh out of the viewer,
  // slug out of localStorage so it doesn't rehydrate on next reload.
  if (viewer3D) viewer3D.clearMesh();
  forgetExampleSlug();
  syncDisplayModeBtn();
  state.listeners.forEach(fn => fn(state.workspace, { type: 'reset' }));
  chatSheet.setScope('global');
  chatSheet.refresh();
  log('Workspace reset.');
};

// -------------------------------------------------------------------------
// Photo attachment for chat
//
// Pipeline:
//   user picks a photo → compress to ~200-500 KB JPEG → store as Blob in
//   IndexedDB (PhotoStorage) under a generated evidence ID → dispatch
//   add-evidence command linking that ID to the current chat scope → also
//   keep a transient base64 copy in chat-sheet's pendingPhotos so the next
//   AI call can include the image as multimodal input.
//
// On reload the IndexedDB blobs survive; the workspace JSON only references
// them by evidence ID, keeping the JSON itself small.
// -------------------------------------------------------------------------

PhotoStorage.init().catch(err => console.warn('PhotoStorage init failed:', err));

/**
 * Process a File (image) by compressing, persisting to IndexedDB,
 * and dispatching add-evidence to attach it. Optional `attachedTo`
 * is the canonical {type, id} pointer (or null). Returns the new
 * evidence ID and compressed Blob.
 *
 * Used by both the chat-upload flow and the detail-modal photo button.
 */
async function savePhotoAsEvidence(file, attachedTo) {
  log(`Compressing ${file.name}…`);
  const blob = await compressImage(file);
  const evidence = newEvidence('photo', {
    attachedTo,
    url: 'idb://placeholder'   // updated below once we have the id
  });
  evidence.url = `idb://${evidence.id}`;
  evidence.fileName = file.name;
  evidence.byteSize = blob.size;

  await PhotoStorage.put(evidence.id, blob, file.name);
  apply(state, { type: 'add-evidence', payload: { evidence } });
  log(`Saved photo ${file.name} (${formatBytes(blob.size)}) → ${evidence.id}`);
  return { evidenceId: evidence.id, blob };
}

$('chat-camera-btn').onclick = () => $('chat-photo-file').click();
$('chat-photo-file').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  for (const file of files) {
    try {
      const { scope, ref } = chatSheet.getCurrentScope();
      // Map chat scope to evidence attachment.
      // 'global' / 'instance' → null (attached to workspace at large)
      // 'part' / 'hypothesis' / 'step' → { type, id }
      const attachedTo = (ref && scope !== 'global' && scope !== 'instance')
        ? { type: scope, id: ref }
        : null;
      const { evidenceId, blob } = await savePhotoAsEvidence(file, attachedTo);

      // Keep transient base64 for the next AI call.
      const base64 = await blobToBase64(blob);
      chatSheet.attachPhoto({
        name: file.name,
        mimeType: blob.type || 'image/jpeg',
        data: base64,
        evidenceId: evidenceId
      });
    } catch (err) {
      console.error(err);
      log(`Photo failed: ${err.message}`);
    }
  }
  e.target.value = '';
});

// Hidden file input used by the detail-modal photo-add button.
// We re-use one input element and re-assign its `attachedTo` target
// just before clicking it programmatically.
const detailPhotoInput = document.createElement('input');
detailPhotoInput.type = 'file';
detailPhotoInput.accept = 'image/*';
detailPhotoInput.multiple = true;
detailPhotoInput.style.display = 'none';
document.body.appendChild(detailPhotoInput);

let pendingDetailAttachTarget = null;
detailPhotoInput.addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  const target = pendingDetailAttachTarget;
  pendingDetailAttachTarget = null;
  for (const file of files) {
    try {
      await savePhotoAsEvidence(file, target);
    } catch (err) {
      console.error(err);
      log(`Photo failed: ${err.message}`);
    }
  }
  e.target.value = '';
  // Re-render the detail modal so the new photo appears
  if (lastDetailTarget) openDetail(lastDetailTarget);
});

function attachPhotoToEntity(target) {
  // target is { type: 'part'|'hypothesis', id }
  pendingDetailAttachTarget = target ? { type: target.type, id: target.id } : null;
  detailPhotoInput.click();
}

// -------------------------------------------------------------------------
// Detail modal — editable forms backed by the apply() command pipeline.
// -------------------------------------------------------------------------

document.querySelectorAll('[data-close-modal]').forEach(b => {
  b.onclick = () => $(b.dataset.closeModal).classList.remove('on');
});

// Close any open modal by clicking on its backdrop (the .modal element
// itself, not any of its descendants — clicks inside the .modal-card
// shouldn't dismiss).
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', e => {
    if (e.target === m) m.classList.remove('on');
  });
});

// Escape closes the topmost open modal (but only if not already handled
// by another listener like place-mode cancellation).
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (inPlaceMode) return;   // place-mode handler will catch this
  const open = [...document.querySelectorAll('.modal.on')];
  if (open.length === 0) return;
  // Close just the most recently opened one (last in DOM order is a reasonable proxy)
  open[open.length - 1].classList.remove('on');
});

const detailEditor = createDetailEditor({
  modalEl: $('detail-modal'),
  titleEl: $('detail-title'),
  bodyEl: $('detail-grid'),
  getWorkspace: () => state.workspace,
  getPhotoBlob: id => PhotoStorage.get(id),
  dispatch: cmd => apply(state, cmd),
  onAttachPhoto: target => attachPhotoToEntity(target)
});

let lastDetailTarget = null;

function openDetail(target) {
  if (!target) return;
  lastDetailTarget = target;
  // Update selections in the rest of the UI as a side effect
  if (target.type === 'part') {
    if (viewer3D) viewer3D.select({ partId: target.id });
    entityList.setSelection({ partId: target.id, hypothesisId: null });
    chatSheet.setScope('part', target.id);
  } else if (target.type === 'hypothesis') {
    const h = (state.workspace.hypotheses || []).find(x => x.id === target.id);
    if (viewer3D) viewer3D.select({ hypothesisId: target.id, partId: h?.partRef });
    entityList.setSelection({ partId: null, hypothesisId: target.id });
    chatSheet.setScope('hypothesis', target.id);
  } else if (target.type === 'step') {
    selectedStepId = target.id;
    actionGraph.setCurrentStep(target.id);
    chatSheet.setScope('step', target.id);
  }
  detailEditor.open(target);
  quickActions.render();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// -------------------------------------------------------------------------
// PROPOSE — the AI-state-change flow
// -------------------------------------------------------------------------

/**
 * Determines whether an interventions-scope propose request should be
 * routed to the dedicated /api/generate-plan endpoint.
 *
 * Returns true for messages that ask the AI to produce a new plan or
 * rebuild an existing one from scratch (where the dedicated planner's
 * specialized prompt and stronger model genuinely help). Returns false
 * for small surgical edits to an existing plan (e.g. "replace step 3 with
 * a different action") where the generic propose endpoint is more
 * appropriate because the model only needs to emit a few small commands.
 */
function isPlanGenerationIntent(userMessage, workspace) {
  if (!userMessage) return false;
  const msg = userMessage.toLowerCase();

  // Strong positive signals that the user wants a full plan (re)generation
  const fullPlanPhrases = [
    'generate plan', 'generate a plan', 'generate the plan',
    'create plan', 'create a plan', 'create the plan',
    'replan', 're-plan', 're plan',
    'new plan',
    'rebuild plan', 'rebuild the plan',
    'plan variant', 'alternative plan'
  ];
  if (fullPlanPhrases.some(p => msg.includes(p))) return true;

  // The quick-action chips emit these literal strings when the user has no
  // typed message. Recognize them too.
  if (msg.startsWith('♻️ replan') || msg.startsWith('📝 generate plan')) return true;

  // If we don't have a plan yet and the user says anything plan-shaped,
  // assume it's plan generation.
  const hasPlan = (workspace?.plans || []).some(p => p.id === workspace?.currentPlanId && p.steps?.length);
  if (!hasPlan && (msg.includes('plan') || msg.includes('steps'))) return true;

  return false;
}

async function runPropose({ scope = 'all', userMessage }) {
  if (proposeInFlight) { log('A proposal is already in progress…'); return; }
  if (!userMessage || !userMessage.trim()) {
    log('Type a message or use the chat to describe what you want.');
    chatSheet.open();
    return;
  }
  const isPlanGenRequestForUi = scope === 'interventions' && isPlanGenerationIntent(userMessage, state.workspace);
  proposeInFlight = true;
  chatSheet.setBusy(true);
  log(isPlanGenRequestForUi
    ? `Generating a full repair plan (Phase A: structure, ~30s)…`
    : `Asking the AI to propose changes (${scope})…`);

  // Record the user-side action in the chat thread so it's findable later
  chatSheet.pushMessage('user', userMessage);
  chatSheet.open();

  // Show a thinking placeholder bubble inline. We update its text every
  // second with elapsed time, so a hanging call is visibly distinct
  // from a slow-but-running call — the previous behaviour gave the
  // user no signal at all and "Waiting for AI response" felt frozen.
  const thinking = document.createElement('div');
  thinking.className = 'chat-bubble chat-llm chat-thinking';
  const baseText = isPlanGenRequestForUi
    ? `Generating plan structure (Gemini 2.5 Pro). Tools/materials/rationale will fill in afterwards in the background.`
    : `Proposing changes (${scope})`;
  thinking.textContent = `${baseText} … 0s`;
  $('chat-history').appendChild(thinking);
  $('chat-history').scrollTop = $('chat-history').scrollHeight;
  const startedAt = Date.now();
  const tickHandle = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (thinking.isConnected) {
      thinking.textContent = `${baseText} … ${elapsed}s`;
    }
  }, 1000);

  // Client-side timeout. Vercel's serverless functions have their own
  // server-side limits (set per route via `maxDuration`), but if the
  // connection stalls earlier — flaky LTE, Vercel cold start, browser
  // suspension — the fetch promise can hang indefinitely. AbortController
  // gives us a deterministic floor so the UI always recovers.
  const controller = new AbortController();
  const TIMEOUT_MS = isPlanGenRequestForUi ? 100_000 : 75_000;
  const timeoutHandle = setTimeout(() => controller.abort('client-timeout'), TIMEOUT_MS);

  try {
    // Plan-generation requests go to the dedicated /api/generate-plan
    // endpoint, which uses a specialized prompt and gemini-2.5-pro for
    // higher-quality results. Other interventions scope requests (small
    // modifications to an existing plan) still go through /api/propose.
    const endpoint = isPlanGenRequestForUi ? '/api/generate-plan' : '/api/propose';
    const body = isPlanGenRequestForUi
      ? { userMessage, workspace: state.workspace }
      : { scope, userMessage, workspace: payloadForPropose({ workspace: state.workspace, scope }) };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    thinking.remove();
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText || `HTTP ${res.status}` }));
      const detail = err.error || `HTTP ${res.status}`;
      log(`Propose failed: ${detail}`);
      chatSheet.pushMessage('assistant', `Proposal failed: ${detail}`);
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

    // If this was a plan-generation, kick off Phase B enrichment in the
    // background. Phase A returned a skeleton with id/title/description/
    // partRefs only — Phase B fills in tools, materials, time, expected
    // outcome, justification, safety, confidence.
    if (isPlanGenRequestForUi) {
      const acceptedPlanCmd = accepted.find(c => c.type === 'add-plan');
      const newPlan = acceptedPlanCmd?.payload?.plan;
      if (newPlan && newPlan.steps?.length) {
        enrichPlanInBackground(newPlan);
      }
    }
  } catch (err) {
    // Distinguish a client-side abort (our 75s timeout) from a real
    // network/parse error. AbortError comes from controller.abort() —
    // either our timeout or the user navigating away. The reason string
    // is set above to 'client-timeout' for our case.
    const wasOurTimeout = err.name === 'AbortError' && controller.signal.reason === 'client-timeout';
    if (wasOurTimeout) {
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      const msg = `The AI did not respond within ${elapsedS}s and was given up on. This usually means a serverless cold start, a slow Gemini response, or a server-side timeout (Vercel's per-route limit). Try again in a moment.`;
      log(`Propose timed out after ${elapsedS}s.`);
      chatSheet.pushMessage('assistant', msg);
    } else {
      log(`Propose error: ${err.message}`);
      chatSheet.pushMessage('assistant', `Error during proposal: ${err.message}`);
    }
  } finally {
    clearInterval(tickHandle);
    clearTimeout(timeoutHandle);
    if (thinking.isConnected) thinking.remove();
    proposeInFlight = false;
    chatSheet.setBusy(false);
  }
}

// -------------------------------------------------------------------------
// Phase B: plan enrichment (background)
//
// After a plan skeleton is generated and accepted, this kicks off a
// secondary AI call that fills in operational + reflective fields per
// step. Runs entirely in the background — UI shows a small spinner on
// each step until the enrichment arrives.
// -------------------------------------------------------------------------

// Set of step IDs that currently have an enrichment in flight. Views read
// this via getEnrichingStepIds() to render the "thinking" indicator.
const enrichingStepIds = new Set();
let enrichmentSeq = 0;

export function getEnrichingStepIds() { return enrichingStepIds; }
// Expose globally so view files that don't import main.js can still query.
window.__getEnrichingStepIds = () => enrichingStepIds;

async function enrichPlanInBackground(plan) {
  const stepIds = plan.steps.map(s => s.id);
  stepIds.forEach(id => enrichingStepIds.add(id));
  enrichmentSeq++;
  const mySeq = enrichmentSeq;

  // Trigger a re-render so the indicator appears
  state.listeners.forEach(fn => fn(state.workspace, { type: 'enrich-start' }));
  log(`Enriching plan in background (${stepIds.length} steps)…`);

  try {
    const res = await fetch('/api/enrich-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: state.workspace,
        plan: {
          id: plan.id,
          label: plan.label,
          steps: plan.steps
        }
      })
    });

    // If another enrichment has started since we began, this one is stale
    if (mySeq !== enrichmentSeq) return;

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      log(`Enrichment failed: ${err.error || res.status} (plan is usable, just less detailed)`);
      return;
    }
    const { enrichments } = await res.json();
    if (!Array.isArray(enrichments) || !enrichments.length) {
      log('Enrichment returned nothing.');
      return;
    }

    // Find the currently-active plan in state. The user may have edited
    // since Phase A — we only update steps that still exist.
    const ws = state.workspace;
    const currentPlan = (ws.plans || []).find(p => p.id === plan.id);
    if (!currentPlan) {
      log('Plan no longer present, skipping enrichment.');
      return;
    }

    // Build upsert-step commands for each enrichment that matches an
    // existing step in the current plan.
    const commands = [];
    for (const e of enrichments) {
      const existing = (currentPlan.steps || []).find(s => s.id === e.id);
      if (!existing) continue;
      const updatedStep = {
        ...existing,
        toolsRequired: e.toolsRequired || existing.toolsRequired || [],
        materialsRequired: e.materialsRequired || existing.materialsRequired || [],
        estimatedMinutes: e.estimatedMinutes ?? existing.estimatedMinutes,
        expectedOutcome: e.expectedOutcome || existing.expectedOutcome || '',
        safetyNotes: e.safetyNotes || existing.safetyNotes || '',
        justification: e.justification || existing.justification,
        confidence: typeof e.confidence === 'number' ? e.confidence : existing.confidence
      };
      commands.push({ type: 'upsert-step', payload: { planId: plan.id, step: updatedStep } });
    }

    if (commands.length) {
      apply(state, {
        type: 'batch',
        payload: { label: 'AI: enrich plan steps', commands }
      });
      log(`Plan enriched: ${commands.length} step${commands.length === 1 ? '' : 's'} updated.`);
    }
  } catch (err) {
    if (mySeq !== enrichmentSeq) return;
    console.error('[enrich] failed:', err);
    log(`Enrichment failed: ${err.message} (plan is usable, just less detailed)`);
  } finally {
    if (mySeq === enrichmentSeq) {
      enrichingStepIds.clear();
      state.listeners.forEach(fn => fn(state.workspace, { type: 'enrich-end' }));
    }
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

// =========================================================================
// IMAGE GENERATION FLOW — "imagine result"
//
// Three-stage pipeline:
//   1. describe-photo: source photo → Ist-JSON (current state)
//   2. synthesize-target-json: Ist + Workspace → Soll-JSON (target state)
//   3. imagine-result: source photo + Soll-JSON → generated image
//
// Stages 1+2 run when user clicks "Imagine repaired state". The review
// modal lets the user inspect/edit the Soll before stage 3 runs.
// =========================================================================

let pendingIstJson = null;
let pendingSollJson = null;

function renderImagineSection(ws) {
  const photos = (ws.evidence || []).filter(e => e.kind === 'photo');
  const sourceId = ws.instance?.sourcePhotoEvidenceId || null;
  const sourceEv = sourceId ? photos.find(p => p.id === sourceId) : null;

  const thumbEl = $('imagine-source-thumb');
  const goBtn = $('imagine-go-btn');
  const pickBtn = $('imagine-pick-btn');

  // Render source thumbnail
  if (sourceEv) {
    thumbEl.innerHTML = '<div class="imagine-source-empty">Loading…</div>';
    PhotoStorage.get(sourceEv.id).then(photo => {
      if (!photo) {
        thumbEl.innerHTML = '<div class="imagine-source-empty">Photo not on device</div>';
        return;
      }
      const url = URL.createObjectURL(photo.blob);
      thumbEl.innerHTML = `<img src="${url}" alt="source">`;
    }).catch(() => {
      thumbEl.innerHTML = '<div class="imagine-source-empty">Failed to load</div>';
    });
    goBtn.disabled = false;
  } else {
    thumbEl.innerHTML = '<div class="imagine-source-empty">No source photo set</div>';
    goBtn.disabled = true;
  }

  pickBtn.disabled = false;
  pickBtn.textContent = photos.length === 0
    ? '📤 Upload source photo'
    : (sourceEv ? '↻ Change source photo' : '📷 Set source photo');

  // Render the most recent generated result, if any
  renderImagineResult(ws);
}

// Which rendering the user is currently looking at as "active". When null,
// we default to the newest rendering. Clicking a thumbnail sets this; a new
// generation resets it (new renderings become the active one).
let activeRenderingId = null;

function renderImagineResult(ws) {
  const wrap = $('imagine-result-wrap');
  // In v2.1 renderings are strategy-scoped via planRef. Show only the
  // ones that belong to the current strategy. Renderings with no planRef
  // (legacy / pre-migration) fall through and are not shown — they were
  // pinned to a specific plan by migration, so an unassigned one is an
  // anomaly the user can ignore.
  const currentPlanId = ws.currentPlanId;
  const renderings = (ws.evidence || []).filter(e =>
    e.kind === 'rendering' && e.planRef === currentPlanId
  );
  if (!renderings.length) {
    activeRenderingId = null;
    wrap.innerHTML = '<div class="imagine-result-empty">No imagined result yet for this strategy.</div>';
    return;
  }
  // Newest first
  const sorted = [...renderings].sort((a, b) =>
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  // Pick the active one. Falls back to the newest if the selected one is gone.
  const active = (activeRenderingId && sorted.find(r => r.id === activeRenderingId))
    || sorted[0];
  // All others, in newest-first order
  const others = sorted.filter(r => r.id !== active.id);

  wrap.innerHTML = `
    <div class="imagine-result-stack">
      <div class="imagine-main"><div class="imagine-result-empty">Loading…</div></div>
      <div class="imagine-refine">
        <textarea class="imagine-refine-input" id="imagine-refine-input" placeholder="Describe a change to apply (e.g. make the legs darker, swap cushion for green wool)…" rows="2"></textarea>
        <button class="imagine-refine-btn" id="imagine-refine-btn">↻ Refine image</button>
      </div>
      ${others.length ? `
        <div class="imagine-versions">
          <div class="imagine-versions-label">Other versions (${others.length}) — click to select</div>
          <div class="imagine-versions-row" id="imagine-versions-row"></div>
        </div>
      ` : ''}
    </div>
  `;

  // Load main image
  PhotoStorage.get(active.id).then(photo => {
    const main = wrap.querySelector('.imagine-main');
    if (!photo) {
      main.innerHTML = '<div class="imagine-result-empty">Image not on device</div>';
      return;
    }
    const url = URL.createObjectURL(photo.blob);
    main.innerHTML = `<img src="${url}" alt="imagined result">`;
    main.querySelector('img').onclick = () => openImageLightbox(url);
  });

  // Wire refine button — always operates on the currently active rendering
  const refineBtn = $('imagine-refine-btn');
  const refineInput = $('imagine-refine-input');
  refineBtn.onclick = () => {
    const text = refineInput.value.trim();
    if (!text) { refineInput.focus(); return; }
    runRefineImage(active, text);
  };
  refineInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      refineBtn.click();
    }
  });

  // Thumbnails: click selects that version as active (no lightbox prompt).
  if (others.length) {
    const row = $('imagine-versions-row');
    Promise.all(others.map(r => PhotoStorage.get(r.id))).then(photos => {
      row.innerHTML = '';
      photos.forEach((p, i) => {
        if (!p) return;
        const url = URL.createObjectURL(p.blob);
        const thumb = document.createElement('div');
        thumb.className = 'imagine-version-thumb';
        thumb.innerHTML = `<img src="${url}" alt="version">`;
        thumb.title = `Select this version (${new Date(others[i].createdAt || 0).toLocaleString()})`;
        thumb.onclick = () => {
          activeRenderingId = others[i].id;
          renderImagineResult(state.workspace);
        };
        row.appendChild(thumb);
      });
    });
  }
}

/**
 * Refine an existing imagined result based on a short user instruction.
 *
 * Calls /api/modify-target-json to mutate the previous rendering's Soll-JSON,
 * then /api/imagine-result with BOTH the original source photo and the
 * previous rendering as references, so the model preserves visual stability
 * across iterations while applying only the requested change.
 *
 * The new rendering is added as a new evidence item (versioning is implicit
 * via createdAt ordering and the basedOnPreviousRenderingId field).
 */
async function runRefineImage(previousRendering, userInstruction) {
  const ws = state.workspace;
  const sourceId = previousRendering.basedOnSourceEvidenceId
    || ws.instance?.sourcePhotoEvidenceId;
  const sourceEv = (ws.evidence || []).find(e => e.id === sourceId);
  if (!sourceEv) { alert('Original source photo missing.'); return; }
  if (!previousRendering.sollJson) { alert('Previous rendering has no Soll-JSON.'); return; }

  const sourcePhoto = await PhotoStorage.get(sourceId);
  if (!sourcePhoto) { alert('Source photo file not on this device.'); return; }
  const prevImage = await PhotoStorage.get(previousRendering.id);
  if (!prevImage) { alert('Previous rendering file not on this device.'); return; }

  const btn = $('imagine-refine-btn');
  const input = $('imagine-refine-input');
  btn.disabled = true;
  input.disabled = true;
  btn.textContent = '⏳ Modifying target…';
  log(`Refining imagined result: "${userInstruction}"`);

  try {
    // Stage 1: modify Soll-JSON based on the user's instruction
    const modResp = await fetch('/api/modify-target-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentSoll: previousRendering.sollJson,
        userInstruction,
        workspace: ws
      })
    });
    if (!modResp.ok) {
      throw new Error('modify-target-json failed: ' + (await modResp.text()));
    }
    const { soll: newSoll, rationale } = await modResp.json();
    log(`Soll-JSON updated: ${rationale || '(no rationale)'}`);

    // Stage 2: generate new image, passing the previous rendering as the
    // second reference image to preserve visual stability
    btn.textContent = '⏳ Generating image…';
    const sourceBase64 = await blobToBase64(sourcePhoto.blob);
    const prevBase64 = await blobToBase64(prevImage.blob);

    const genResp = await fetch('/api/imagine-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: {
          name: sourceEv.fileName || 'source.jpg',
          mimeType: sourcePhoto.blob.type || 'image/jpeg',
          data: sourceBase64
        },
        soll: newSoll,
        previousRendering: {
          mimeType: prevImage.blob.type || 'image/png',
          data: prevBase64
        }
      })
    });
    if (!genResp.ok) throw new Error('imagine-result failed: ' + (await genResp.text()));
    const { image } = await genResp.json();

    // Persist as a new rendering evidence
    const imgBlob = await dataUrlToBlob(image);
    const rendering = newEvidence('rendering', {
      attachedTo: null,
      url: 'idb://placeholder'
    });
    rendering.url = `idb://${rendering.id}`;
    rendering.fileName = `imagined-refined-${Date.now()}.png`;
    rendering.byteSize = imgBlob.size;
    rendering.basedOnSourceEvidenceId = sourceId;
    rendering.basedOnPreviousRenderingId = previousRendering.id;
    rendering.sollJson = newSoll;
    rendering.istJson = previousRendering.istJson;
    rendering.refinementInstruction = userInstruction;
    rendering.refinementRationale = rationale;
    // Anchor this rendering to the current strategy so the imagined-result
    // panel only shows it for that strategy.
    rendering.planRef = state.workspace.currentPlanId || null;

    await PhotoStorage.put(rendering.id, imgBlob, rendering.fileName);
    apply(state, { type: 'add-evidence', payload: { evidence: rendering } });
    activeRenderingId = rendering.id;
    log(`Refined imagined result → ${rendering.id}`);
  } catch (err) {
    console.error('[refine] failed:', err);
    alert('Refinement failed: ' + err.message);
  } finally {
    btn.disabled = false;
    input.disabled = false;
    btn.textContent = '↻ Refine image';
    input.value = '';
  }
}

function openImageLightbox(url) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:1000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:24px;box-sizing:border-box;';
  // Use calc(100vw - padding) / calc(100vh - padding) explicitly so the image
  // never exceeds viewport — object-fit:contain alone isn't enough when the
  // container can grow with its content.
  div.innerHTML = `<img src="${url}" style="max-width:calc(100vw - 48px);max-height:calc(100vh - 48px);width:auto;height:auto;object-fit:contain;border-radius:6px;display:block;">`;
  div.onclick = () => div.remove();
  document.body.appendChild(div);
}

// -------- Example assets: cover image + optional textured mesh --------
//
// When an example is loaded we attempt to attach two optional assets:
//   - cover.{jpg,jpeg,png,webp} → stored as a data URL on instance.coverImage
//   - mesh.glb                   → loaded into the 3D viewer as a static
//                                   overlay aligned to workspace coords
//
// The cover travels with the workspace (persisted in instance.coverImage).
// The mesh is too big to bake into the JSON, so we instead remember which
// example we loaded in localStorage; on a page reload that slug is used
// to re-fetch mesh.glb. Sharing a JSON does NOT transfer the mesh — the
// recipient just sees the box model unless they reload from the example
// dropdown themselves.

const COVER_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const SLUG_STORAGE_KEY = 'repair-workspace-v2-example-slug';

function rememberExampleSlug(slug) {
  try { localStorage.setItem(SLUG_STORAGE_KEY, slug); } catch { /* quota etc — non-fatal */ }
}
function forgetExampleSlug() {
  try { localStorage.removeItem(SLUG_STORAGE_KEY); } catch {}
}
function recalledExampleSlug() {
  try { return localStorage.getItem(SLUG_STORAGE_KEY); } catch { return null; }
}

async function attachExampleAssets(slug) {
  await attachExampleCover(slug);
  await attachExampleMesh(slug);
  rememberExampleSlug(slug);
}

function renderCover(ws) {
  const wrap = $('artefact-cover');
  const img = $('artefact-cover-img');
  const src = ws.instance?.coverImage || null;
  if (!src) {
    wrap.hidden = true;
    wrap.onclick = null;
    img.removeAttribute('src');
    return;
  }
  if (img.getAttribute('src') !== src) img.src = src;
  wrap.hidden = false;
  wrap.onclick = () => openImageLightbox(src);
}

// Try /examples/<slug>/cover.{jpg,jpeg,png,webp} in order. First hit
// wins and is stored as a data URL on instance.coverImage. If none
// exist, the workspace is left without a cover — a graceful no-op.
async function attachExampleCover(slug) {
  for (const ext of COVER_EXTS) {
    try {
      const res = await fetch(`/examples/${slug}/cover.${ext}`);
      if (!res.ok) continue;
      const blob = await res.blob();
      const dataUrl = await blobToDataUrl(blob);
      // Mutate via the same channel as other workspace edits so
      // autoPersist captures it and renderAll re-runs.
      state.workspace = {
        ...state.workspace,
        instance: { ...state.workspace.instance, coverImage: dataUrl }
      };
      state.listeners.forEach(fn => fn(state.workspace, { type: 'set-cover' }));
      return true;
    } catch { /* try next extension */ }
  }
  return false;
}

// Try /examples/<slug>/mesh.glb. Silent no-op if absent. Logs to the
// in-app status line so the user can see whether a mesh was attached;
// the console gets a detailed entry too. Always calls
// syncDisplayModeBtn at the end so the toggle's visibility reflects
// the true loaded state, even if loading failed.
async function attachExampleMesh(slug) {
  if (!viewer3D) return false;
  const url = `/examples/${slug}/mesh.glb`;
  let probeOk = false;
  try {
    // HEAD check first so a missing file doesn't surface as a GLTFLoader
    // parse error in the console — the common case is "no mesh present"
    // and we want that to be silent.
    const probe = await fetch(url, { method: 'HEAD' });
    probeOk = probe.ok;
  } catch (err) {
    console.warn('[mesh] HEAD probe failed', url, err);
  }
  if (!probeOk) {
    syncDisplayModeBtn();
    return false;
  }
  log(`Loading 3D scan…`);
  const ok = await viewer3D.loadMesh(url);
  syncDisplayModeBtn();
  if (ok) log(`3D scan loaded for ${slug}.`);
  else log(`3D scan present but failed to parse (see console).`);
  return ok;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// -------- Source-photo picker -----------------------------------
//
// Hidden file input used for "upload new photo" in the source picker.
// Reused across opens; we reset its value before each click so the same
// file can be re-selected if the user wants to.
const imagineUploadInput = document.createElement('input');
imagineUploadInput.type = 'file';
imagineUploadInput.accept = 'image/*';
imagineUploadInput.style.display = 'none';
document.body.appendChild(imagineUploadInput);

imagineUploadInput.addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  try {
    // Reuse the same save-photo-as-evidence pipeline used everywhere else
    const { evidenceId } = await savePhotoAsEvidence(file, null);
    // Now set it as the source photo
    state.workspace = {
      ...state.workspace,
      instance: {
        ...state.workspace.instance,
        sourcePhotoEvidenceId: evidenceId
      }
    };
    state.listeners.forEach(fn => fn(state.workspace, { type: 'set-source-photo' }));
    $('source-picker-modal').classList.remove('on');
    log(`Uploaded and set source photo: ${file.name}`);
  } catch (err) {
    console.error('[imagine upload] failed:', err);
    alert('Upload failed: ' + err.message);
  }
});

$('imagine-pick-btn').onclick = () => {
  const ws = state.workspace;
  const photos = (ws.evidence || []).filter(e => e.kind === 'photo');
  const sourceId = ws.instance?.sourcePhotoEvidenceId || null;
  const grid = $('source-picker-grid');
  grid.innerHTML = '';

  // Always-on "Upload new photo" tile, first in the grid
  const uploadTile = document.createElement('div');
  uploadTile.className = 'source-picker-tile upload-tile';
  uploadTile.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:6px;color:var(--info);">
      <div style="font-size:28px;line-height:1;">📤</div>
      <div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Upload new</div>
    </div>`;
  uploadTile.onclick = () => imagineUploadInput.click();
  grid.appendChild(uploadTile);

  if (!photos.length) {
    const hint = document.createElement('div');
    hint.className = 'source-picker-grid-empty';
    hint.style.gridColumn = '2 / -1';
    hint.textContent = 'No photos yet. Click "Upload new" to add one — or upload via the chat camera or detail-modal "Add photo" button.';
    grid.appendChild(hint);
  } else {
    for (const ev of photos) {
      const tile = document.createElement('div');
      tile.className = 'source-picker-tile' + (ev.id === sourceId ? ' selected' : '');
      tile.innerHTML = '<div style="display:grid;place-items:center;height:100%;font-family:var(--mono);font-size:10px;color:var(--ink-mute);">…</div>';
      grid.appendChild(tile);

      PhotoStorage.get(ev.id).then(photo => {
        if (!photo) {
          tile.innerHTML = '<div style="display:grid;place-items:center;height:100%;font-family:var(--mono);font-size:10px;color:var(--ink-mute);">missing</div>';
          return;
        }
        const url = URL.createObjectURL(photo.blob);
        tile.innerHTML = `<img src="${url}" alt="">`;
      });

      tile.onclick = () => {
        state.workspace = {
          ...state.workspace,
          instance: {
            ...state.workspace.instance,
            sourcePhotoEvidenceId: ev.id
          }
        };
        state.listeners.forEach(fn => fn(state.workspace, { type: 'set-source-photo' }));
        $('source-picker-modal').classList.remove('on');
        log(`Set source photo: ${ev.fileName || ev.id}`);
      };
    }
  }
  $('source-picker-modal').classList.add('on');
};

// -------- "Imagine repaired state" entry point ------------------
$('imagine-go-btn').onclick = async () => {
  const ws = state.workspace;
  const sourceId = ws.instance?.sourcePhotoEvidenceId;
  if (!sourceId) { log('Please set a source photo first.'); return; }

  const ev = (ws.evidence || []).find(e => e.id === sourceId);
  if (!ev) { log('Source photo evidence missing.'); return; }

  const photo = await PhotoStorage.get(sourceId);
  if (!photo) { log('Source photo file not on this device.'); return; }

  const goBtn = $('imagine-go-btn');
  const statusEl = $('imagine-status');
  goBtn.disabled = true;
  goBtn.classList.add('busy');
  goBtn.textContent = '⏳ Analyzing photo…';
  statusEl.textContent = 'Step 1 of 3: describing what is in the photo…';

  try {
    const base64 = await blobToBase64(photo.blob);
    const filePayload = {
      name: ev.fileName || 'source.jpg',
      mimeType: photo.blob.type || 'image/jpeg',
      data: base64
    };

    // Stage 1 — describe-photo
    const istResp = await fetch('/api/describe-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: filePayload, workspace: ws })
    });
    if (!istResp.ok) throw new Error('describe-photo failed: ' + (await istResp.text()));
    const { ist } = await istResp.json();
    pendingIstJson = ist;

    // Stage 2 — synthesize-target-json
    goBtn.textContent = '⏳ Planning the edit…';
    statusEl.textContent = 'Step 2 of 3: synthesizing the target description…';
    const sollResp = await fetch('/api/synthesize-target-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ist, workspace: ws })
    });
    if (!sollResp.ok) throw new Error('synthesize-target-json failed: ' + (await sollResp.text()));
    const { soll, rationale } = await sollResp.json();
    pendingSollJson = soll;

    // Show the review modal
    $('soll-review-rationale').textContent = rationale || '(no rationale provided)';
    $('ist-textarea').value = JSON.stringify(ist, null, 2);
    $('soll-textarea').value = JSON.stringify(soll, null, 2);
    $('soll-review-modal').classList.add('on');
    statusEl.textContent = 'Review the target description and click Generate Image.';
    goBtn.textContent = '✨ Imagine repaired state';
    goBtn.classList.remove('busy');
    goBtn.disabled = false;
  } catch (err) {
    console.error('[imagine] stage 1-2 failed:', err);
    log(`Imagine failed: ${err.message}`);
    statusEl.textContent = `Failed: ${err.message}`;
    goBtn.textContent = '✨ Imagine repaired state';
    goBtn.classList.remove('busy');
    goBtn.disabled = false;
  }
};

// -------- Stage 3 from the review modal -------------------------
$('soll-generate-btn').onclick = async () => {
  let editedSoll;
  try {
    editedSoll = JSON.parse($('soll-textarea').value);
  } catch (err) {
    alert('Target JSON is not valid JSON: ' + err.message);
    return;
  }

  const ws = state.workspace;
  const sourceId = ws.instance?.sourcePhotoEvidenceId;
  const ev = (ws.evidence || []).find(e => e.id === sourceId);
  if (!ev) { alert('Source photo missing.'); return; }
  const photo = await PhotoStorage.get(sourceId);
  if (!photo) { alert('Source photo file not on this device.'); return; }

  const generateBtn = $('soll-generate-btn');
  generateBtn.disabled = true;
  generateBtn.textContent = '⏳ Generating…';

  try {
    const base64 = await blobToBase64(photo.blob);
    const filePayload = {
      name: ev.fileName || 'source.jpg',
      mimeType: photo.blob.type || 'image/jpeg',
      data: base64
    };
    const resp = await fetch('/api/imagine-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: filePayload, soll: editedSoll })
    });
    if (!resp.ok) throw new Error('imagine-result failed: ' + (await resp.text()));
    const { image } = await resp.json();

    // Decode data URL back to a Blob and persist as evidence
    const imgBlob = await dataUrlToBlob(image);
    const rendering = newEvidence('rendering', {
      attachedTo: null,
      url: 'idb://placeholder'
    });
    rendering.url = `idb://${rendering.id}`;
    rendering.fileName = `imagined-${Date.now()}.png`;
    rendering.byteSize = imgBlob.size;
    rendering.basedOnSourceEvidenceId = sourceId;
    rendering.sollJson = editedSoll;
    rendering.istJson = pendingIstJson;
    // Anchor to the current strategy.
    rendering.planRef = state.workspace.currentPlanId || null;

    await PhotoStorage.put(rendering.id, imgBlob, rendering.fileName);
    apply(state, { type: 'add-evidence', payload: { evidence: rendering } });
    activeRenderingId = rendering.id;
    log(`Generated imagined result → ${rendering.id}`);

    $('soll-review-modal').classList.remove('on');
    $('imagine-status').textContent = 'Done.';
  } catch (err) {
    console.error('[imagine] stage 3 failed:', err);
    alert('Image generation failed: ' + err.message);
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = '✨ Generate image';
  }
};

async function dataUrlToBlob(dataUrl) {
  const r = await fetch(dataUrl);
  return r.blob();
}

renderAll();
setTimeout(() => viewer3D.resize(), 50);
chatSheet.setScope('global');

// Rehydrate the textured mesh overlay if the previous session loaded
// an example. The slug lives in localStorage (not the workspace JSON)
// because mesh.glb is large and tied to the example folder, not the
// artefact. Silent no-op when there's nothing to rehydrate.
(async function rehydrateMesh() {
  const slug = recalledExampleSlug();
  if (!slug) return;
  await attachExampleMesh(slug);
})();

log('Workspace ready.');
