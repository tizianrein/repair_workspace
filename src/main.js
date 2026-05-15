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
import { newWorkspace, validateWorkspace, SCHEMA_VERSION, newEvidence, newHypothesis } from './core/schema.js';
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
  renderImagineSection(ws);
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

  const hypCount = (ws.hypotheses || []).length;
  $('fab-right-badge').hidden = hypCount === 0;
  $('fab-right-badge').textContent = hypCount;

  // 3D empty-state hint: shown when no parts at all (fresh workspace
  // before example is loaded or assembly is extracted).
  const partsCount = ws.instance?.parts?.length || 0;
  const emptyEl = document.getElementById('viewer-empty');
  if (emptyEl) emptyEl.hidden = partsCount > 0;
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

  // Show a thinking placeholder bubble inline
  const thinking = document.createElement('div');
  thinking.className = 'chat-bubble chat-llm chat-thinking';
  thinking.textContent = isPlanGenRequestForUi
    ? `Generating plan structure (Gemini 2.5 Pro, ~30s). Tools/materials/rationale will fill in afterwards in the background.`
    : `Proposing changes (${scope})…`;
  $('chat-history').appendChild(thinking);
  $('chat-history').scrollTop = $('chat-history').scrollHeight;

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
      body: JSON.stringify(body)
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
    log(`Propose error: ${err.message}`);
    chatSheet.pushMessage('assistant', `Error during proposal: ${err.message}`);
  } finally {
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

function renderImagineResult(ws) {
  const wrap = $('imagine-result-wrap');
  const renderings = (ws.evidence || []).filter(e => e.kind === 'rendering');
  if (!renderings.length) {
    wrap.innerHTML = '<div class="imagine-result-empty">No imagined result yet.</div>';
    return;
  }
  // Newest first
  const sorted = [...renderings].sort((a, b) =>
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const latest = sorted[0];
  const older = sorted.slice(1);

  wrap.innerHTML = `
    <div class="imagine-result-stack">
      <div class="imagine-main"><div class="imagine-result-empty">Loading…</div></div>
      <div class="imagine-refine">
        <textarea class="imagine-refine-input" id="imagine-refine-input" placeholder="Describe a change to apply (e.g. make the legs darker, swap cushion for green wool)…" rows="2"></textarea>
        <button class="imagine-refine-btn" id="imagine-refine-btn">↻ Refine image</button>
      </div>
      ${older.length ? `
        <div class="imagine-versions">
          <div class="imagine-versions-label">Earlier versions (${older.length})</div>
          <div class="imagine-versions-row" id="imagine-versions-row"></div>
        </div>
      ` : ''}
    </div>
  `;

  // Load main image
  PhotoStorage.get(latest.id).then(photo => {
    const main = wrap.querySelector('.imagine-main');
    if (!photo) {
      main.innerHTML = '<div class="imagine-result-empty">Image not on device</div>';
      return;
    }
    const url = URL.createObjectURL(photo.blob);
    main.innerHTML = `<img src="${url}" alt="imagined result">`;
    main.querySelector('img').onclick = () => openImageLightbox(url);
  });

  // Wire refine button
  const refineBtn = $('imagine-refine-btn');
  const refineInput = $('imagine-refine-input');
  refineBtn.onclick = () => {
    const text = refineInput.value.trim();
    if (!text) {
      refineInput.focus();
      return;
    }
    runRefineImage(latest, text);
  };
  refineInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      refineBtn.click();
    }
  });

  // Load thumbnails of older versions
  if (older.length) {
    const row = $('imagine-versions-row');
    Promise.all(older.map(r => PhotoStorage.get(r.id))).then(photos => {
      row.innerHTML = '';
      photos.forEach((p, i) => {
        if (!p) return;
        const url = URL.createObjectURL(p.blob);
        const thumb = document.createElement('div');
        thumb.className = 'imagine-version-thumb';
        thumb.innerHTML = `<img src="${url}" alt="earlier version">`;
        thumb.title = new Date(older[i].createdAt || 0).toLocaleString();
        thumb.onclick = () => openImageLightbox(url);
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

    await PhotoStorage.put(rendering.id, imgBlob, rendering.fileName);
    apply(state, { type: 'add-evidence', payload: { evidence: rendering } });
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

    await PhotoStorage.put(rendering.id, imgBlob, rendering.fileName);
    apply(state, { type: 'add-evidence', payload: { evidence: rendering } });
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
log('Workspace ready.');
