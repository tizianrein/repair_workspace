/**
 * main.js — application entry point.
 *
 * Wires together state, views, AI endpoints, and user interactions.
 *
 * There is ONE AI flow: chat with tool-calling.
 *
 *   user types → POST /api/chat → the model answers and, when it wants to
 *   change something, emits tool calls that come back as a list of
 *   commands. Those are applied directly as a single `batch` through
 *   apply() — there is no separate review/accept step. The chat bubble
 *   renders an audit record of exactly what was applied (see the
 *   `✓ Applied:` card in chat-sheet.js), and because the whole turn is one
 *   batch, Ctrl+Z reverts it in one go. That pairing — visible audit
 *   record plus single-keystroke undo — is what makes applying without
 *   confirmation safe.
 *
 * Plan enrichment (Phase B) hangs off that same flow: when a chat turn
 * creates a plan, enrichPlanInBackground() calls /api/enrich-plan to fill
 * in tools, materials, time estimates, rationale and confidence per step.
 *
 * Everything else (entity selection, scope changes, photo attach, mark-
 * complete, intent editing) is a state-mutating action that goes through
 * the same apply() pipeline.
 */

import { createState, subscribe, autoPersist, restore,
         saveIdentity, loadIdentity } from './core/state.js';
import { apply, undo, redo } from './core/commands.js';
import { migrateV1ToV2 } from './core/migrate.js';
import { newWorkspace, validateWorkspace, SCHEMA_VERSION, newEvidence, newCondition, newMessage,
         newIntent, newPlan, pickStrategyColor,
         getCurrentPlan, getCurrentIntent, getCurrentConstraints } from './core/schema.js';
import { PhotoStorage } from './core/photo-storage.js';
import { compressImage, blobToBase64, formatBytes } from './core/image-compress.js';
import { exportWorkspaceBundle, importWorkspaceBundle, downloadBlob,
         binaryEvidence, exportStrategyBundle } from './core/workspace-bundle.js';
import { showStrategyPicker } from './views/strategy-picker.js';
import { createViewer3D } from './views/viewer-3d.js';
import { createActionGraph } from './views/action-graph.js';
import { createSpatialGraph } from './views/spatial-graph.js';
import { createRadar } from './views/radar.js';
import { createEntityList } from './views/entity-list.js';
import { createChatSheet } from './views/chat-sheet.js';
import { showExecutionEntry } from './views/execution-log.js';
import { createDetailEditor } from './views/detail-editor.js';
import { createRepairProposalView } from './views/repair-proposals.js';
import {
  CollaborationApi, createProjectId, exampleProjectId,
  normalizeAuthorKey, normalizeAuthorName, projectShareUrl, projectTemplate
} from './core/collaboration.js';
import { createLayerSync, applyLayer, SYNC_STATE } from './core/layer-sync.js';
import { createCorpus, formatSize } from './core/corpus.js';

const state = createState();
let viewer3D = null, actionGraph = null, spatialGraph = null;
let radar = null, entityList = null, chatSheet = null;
let activeTab = 'pane-3d';
let selectedStepId = null;
let viewerDirty = {};
let collaborationSuppressSync = false;
let layerSync = null;

const $ = id => document.getElementById(id);
function log(msg) { $('console-output').textContent = msg; }

// The chat's "default" scope used to mean global, but that fights the
// way the user actually works: most chatting is about whatever strategy
// is current, not the project as a whole. So when we reset the chat
// scope (background click in the 3D viewer, clearing selection, app
// boot, loading a workspace), we resolve to the current plan's thread
// if a plan exists, and fall back to global only when there's no plan
// to talk about. Global is then reserved for cross-cutting
// conversations the user explicitly opens (e.g. by clicking the
// scope pill — wired separately).
function defaultChatScope() {
  const ws = state.workspace;
  const planId = ws?.currentPlanId;
  if (planId && (ws.plans || []).some(p => p.id === planId)) {
    return { scope: 'plan', ref: planId };
  }
  return { scope: 'global', ref: null };
}
function resetChatScope() {
  const s = defaultChatScope();
  chatSheet.setScope(s.scope, s.ref);
}

restore(state);
// A failed write must be visible. This used to swallow the exception, so once
// localStorage filled up the app carried on against a stale stored copy and a
// refresh silently rolled the participant back.
autoPersist(state, message => {
  log(message);
  setCollaborationStatus(message, 'error');
});

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
      entityList.setSelection({ partId: null, conditionId: null });
      if (viewer3D) viewer3D.select({ partId: null, conditionId: null });
      resetChatScope();
    }
  },
  onDetail: stepId => openDetail({ type: 'step', id: stepId })
});

spatialGraph = createSpatialGraph($('spatial-graph-canvas'), {
  onDetail: target => openDetail(target),
  onBackgroundTap: () => {
    entityList.setSelection({ partId: null, conditionId: null });
    if (viewer3D) viewer3D.select({ partId: null, conditionId: null });
    selectedStepId = null;
    resetChatScope();
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

const repairProposalView = createRepairProposalView({
  sectionEl: $('repair-proposals-section'),
  countEl: $('repair-proposal-count'),
  listEl: $('repair-proposal-list'),
  onOpenStep: ({ planId, stepId }) => {
    if (planId && state.workspace.currentPlanId !== planId) {
      apply(state, { type: 'set-current-plan', payload: { planId } });
    }
    openDetail({ type: 'step', id: stepId });
  },
});

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
    // Resolve a rendering id to a displayable URL for the chat bubble. The
    // bytes live in this browser's IndexedDB, so a rendering generated on
    // another device resolves to null and the bubble simply shows its text.
    getRenderingUrl: async renderingId => {
      const rec = await PhotoStorage.get(renderingId);
      return rec?.blob ? imagineUrl(rec.blob) : null;
    },
    // The assistant asked for the imagined result to be regenerated. Runs
    // here rather than server-side: the image bytes live in IndexedDB and
    // generation outlasts the chat endpoint's budget. By the time this fires
    // the turn's commands have already applied, so if the objection changed
    // the plan, the new image is generated from the corrected plan.
    onRenderRequest: ({ instruction, planId }) => {
      runRenderRequest(instruction, planId).catch(err => {
        console.error('[render-request] failed:', err);
        log(`Could not regenerate the image: ${err.message}`);
      });
    },
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
      // If the AI created a new plan in this batch, we'll switch the chat
      // scope to that plan's thread after the batch applies. set-current-plan
      // (emitted by the AI when it wants to switch) is also honored. The
      // intent is that "create a new strategy doing the opposite" lands the
      // user in the new strategy's chat with the conversation that follows.
      // NOTE: the chat engine's `create_plan` tool emits a command of type
      // `add-plan` (the underlying schema action). Not `create-plan` — the
      // tool name and command name don't match, which bit us once already.
      const planAdd    = commands.find(c => c.type === 'add-plan' && c.payload?.plan?.id);
      const setActive  = commands.find(c => c.type === 'set-current-plan' && c.payload?.planId);
      apply(state, {
        type: 'batch',
        payload: {
          commands,
          label: `AI: ${summary || (commands.length + ' changes')}`
        }
      });
      // Pick the target: an explicit set-current-plan wins, otherwise a
      // newly-created plan, otherwise no scope change.
      const newPlanId = setActive?.payload?.planId || planAdd?.payload?.plan?.id || null;
      if (newPlanId) {
        chatSheet.setScope('plan', newPlanId);
      }

      // Phase B: if this turn created a plan, fill in the operational and
      // reflective per-step fields in the background. The chat model writes
      // plan structure (titles, descriptions, dependencies) but rarely the
      // full detail set, so /api/enrich-plan does a focused second pass.
      // Read the plan back out of state rather than trusting the command
      // payload — apply() normalizes it, and that normalized copy is what
      // the enrichment's upsert-step commands must match.
      if (planAdd) {
        const created = (state.workspace.plans || []).find(p => p.id === planAdd.payload.plan.id);
        if (created && needsEnrichment(created)) enrichPlanInBackground(created);
      }
    },

    // What the assistant may read: project documents plus the CURRENT
    // strategy's own — never another strategy's. That isolation is what keeps
    // two strategies reasoning from different evidence instead of converging
    // on one shared base. Only the index travels (a summary per document);
    // full text is fetched server-side when the model asks for a document.
    getCorpusIndex: async () => {
      if (!state.collaboration.projectId) return null;
      try {
        const documents = await ensureCorpus().contextIndex();
        if (!documents.length) return null;
        return {
          projectId: state.collaboration.projectId,
          documents,
          // The retrieval scope travels with the request so semantic search
          // resolves against project documents plus THIS strategy's, and
          // never another's.
          planId: state.workspace.currentPlanId || null,
          authorKey: state.collaboration.activeAuthorKey || null,
          authorName: state.collaboration.activeAuthorName || null,
        };
      } catch {
        return null;   // corpus unavailable: chat still works, just ungrounded
      }
    }
  }
);

viewer3D = createViewer3D(
  $('viewer-canvas'),
  $('info-box'),
  target => {
    if (target) {
      openDetail({ type: target.type, id: target.data.id });
    } else {
      // Background click → clear selection, return to global chat scope
      entityList.setSelection({ partId: null, conditionId: null });
      resetChatScope();
    }
  }
);
$('explode-btn').onclick = () => {
  viewer3D.toggleExplode();
  $('explode-btn').textContent = viewer3D.isExploded() ? '↩️' : '💥';
  $('explode-btn').title = viewer3D.isExploded() ? 'Restore view' : 'Explode view';
};

// Display-mode toggle for the GLB-derived views. Lives in the Data section
// of the left sidebar and cycles boxes → boxes + point cloud → mesh → boxes.
// Hidden unless a mesh is actually loaded into the viewer.
function syncDisplayModeBtn() {
  const btn = $('display-mode-btn');
  const pointSizeControl = $('point-size-control');
  if (!btn) return;
  if (!viewer3D || !viewer3D.hasMesh()) {
    btn.hidden = true;
    if (pointSizeControl) pointSizeControl.hidden = true;
    return;
  }
  btn.hidden = false;
  const mode = viewer3D.getDisplayMode();
  // Label is "Showing X · click for Y" — explicit because the sidebar
  // has room, and because users don't always remember what the icons
  // mean. The leading glyph mirrors what the viewer is currently
  // displaying so it doubles as a state indicator.
  if (mode === 'boxes-points') { btn.textContent = '✣ Boxes + point cloud → mesh'; }
  else if (mode === 'mesh')    { btn.textContent = '🧊 Showing mesh → boxes'; }
  else                         { btn.textContent = '📦 Showing boxes → boxes + point cloud'; }
  if (pointSizeControl) pointSizeControl.hidden = mode !== 'boxes-points';
}
$('display-mode-btn').onclick = () => {
  if (!viewer3D || !viewer3D.hasMesh()) return;
  const mode = viewer3D.getDisplayMode();
  const next = mode === 'boxes' ? 'boxes-points' : mode === 'boxes-points' ? 'mesh' : 'boxes';
  viewer3D.setDisplayMode(next);
  syncDisplayModeBtn();
};

const pointSizeSlider = $('point-size-slider');
const pointSizeValue = $('point-size-value');
function syncPointSizeValue(size = viewer3D?.getPointSize()) {
  if (!pointSizeSlider || !pointSizeValue || !Number.isFinite(size)) return;
  pointSizeSlider.value = String(size);
  pointSizeValue.value = `${Number(size).toFixed(1)} px`;
}
if (pointSizeSlider) {
  syncPointSizeValue();
  pointSizeSlider.oninput = () => {
    const size = Number(pointSizeSlider.value);
    viewer3D?.setPointSize(size);
    syncPointSizeValue(size);
  };
}

// -------------------------------------------------------------------------
// Manual "place new condition" mode
//
// Entry: user clicks "+ New condition" in the right drawer.
// Flow:
//   1. Switch to Proxy/3D tab (if not already)
//   2. Activate place mode in viewer-3d → crosshair cursor, banner appears
//   3. User clicks on a part in the 3D view
//   4. We dispatch add-condition with partRef + world coordinates
//   5. Exit place mode, then open the detail editor on the new condition
//      so the user can fill in type, description, status, attach photos.
// Cancel: Esc, or click the Cancel button in the banner, or click the
//   "+ New condition" button again (toggle).
// -------------------------------------------------------------------------

let inPlaceMode = false;

function enterPlaceMode() {
  if (inPlaceMode) return;
  if (state.collaboration?.readOnly) {
    log('All conditions is a read-only overview. Switch to My conditions to add an observation.');
    return;
  }
  const ws = state.workspace;
  if (!ws.instance?.parts?.length) {
    log('No parts to attach a condition to. Load an artefact first.');
    return;
  }
  // Make sure we're on the 3D tab
  if (activeTab !== 'pane-3d') {
    const tab = document.querySelector('[data-pane="pane-3d"]');
    if (tab) tab.click();
  }
  inPlaceMode = true;
  $('place-banner').hidden = false;
  $('new-condition-btn').classList.add('active');
  $('new-condition-btn').textContent = '✕ Cancel placement';
  if (viewer3D) {
    viewer3D.setPlaceMode(true, ({ part, point }) => {
      // Build the new condition with sensible defaults
      const newHyp = newCondition({
        type: 'New condition',
        description: '',
        partRef: part.id,
        // Millimetre precision is the finest anything here is authored or
        // measured at; a raycast hit otherwise writes 15 digits of float noise
        // into the workspace JSON and into every AI payload.
        coordinates: { x: round3(point.x), y: round3(point.y), z: round3(point.z) },
        status: 'suspected',
        confidence: 0.5,
        authorName: state.collaboration?.activeAuthorName || null,
        authorKey: state.collaboration?.activeAuthorKey || null
      });
      apply(state, { type: 'add-condition', payload: { condition: newHyp } });
      exitPlaceMode();
      log(`Added new condition on ${part.id}. Edit it below.`);
      // Open the detail editor on the new condition so the user can fill it in
      openDetail({ type: 'condition', id: newHyp.id });
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
  $('object-stats').textContent = `${ws.instance?.parts?.length || 0} parts · ${ws.conditions?.length || 0} condition${(ws.conditions?.length || 0) === 1 ? '' : 's'}`;
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
  repairProposalView.render(ws);
  renderImagineSection(ws);
  renderCover(ws);

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

  const hypCount = (ws.conditions || []).length;
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

    // Click the main body → switch strategy AND switch chat to this
    // strategy's thread. Action buttons handle their own events and stop
    // propagation so they don't also fire the switch.
    div.querySelector('.strategy-main').onclick = () => {
      if (!isCurrent) apply(state, { type: 'set-current-plan', payload: { planId: p.id } });
      // Move the chat to the per-strategy thread even if this strategy is
      // already current — the user may have navigated to global scope and
      // come back, in which case clicking the strategy should return
      // them to its thread.
      chatSheet?.setScope('plan', p.id);
    };
    div.querySelector('[data-act="export"]').onclick = (e) => {
      e.stopPropagation();
      exportStrategy(p.id);
    };
    div.querySelector('[data-act="delete"]').onclick = (e) => {
      e.stopPropagation();
      const ok = confirm(`Delete strategy "${p.label}"?\n\nThis only removes the strategy. The artefact, conditions, and evidence are not affected.`);
      if (ok) {
        // If the chat is currently scoped to this strategy's thread, we
        // need to move it elsewhere before its thread disappears. We do
        // that AFTER the remove-plan applies, because remove-plan falls
        // currentPlanId back to the next surviving plan — resetChatScope
        // then naturally lands on that plan (or global if none remain).
        const cur = chatSheet?.getCurrentScope?.();
        const wasOnDeletedPlan = cur?.scope === 'plan' && cur.ref === p.id;
        apply(state, { type: 'remove-plan', payload: { planId: p.id } });
        if (wasOnDeletedPlan) resetChatScope();
      }
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
/**
 * Corpus access for the exporter: the documents in scope for one strategy,
 * their extracted text, and the originals of that strategy's own documents.
 */
function corpusBundleAccess() {
  const projectId = state.collaboration.projectId;
  if (!projectId) return null;
  const authorKey = state.collaboration.activeAuthorKey || null;
  return {
    listForPlan: planId => CollaborationApi.listCorpus(projectId, { planId, authorKey }),
    getText: async docId => (await CollaborationApi.getCorpusText(projectId, docId)).text || null,
    getOriginal: async docId => {
      const res = await fetch(
        collabOrigin() + '/projects/' + encodeURIComponent(projectId)
        + '/corpus/' + encodeURIComponent(docId),
      );
      return res.ok ? res.blob() : null;
    },
  };
}

function collabOrigin() {
  const configured = String(import.meta.env?.VITE_COLLAB_API_URL || '').replace(/\/$/, '');
  return configured.endsWith('/api/collaboration')
    ? configured
    : configured + '/api/collaboration';
}

async function exportStrategy(planId) {
  try {
    const { blob, filename, photoCount } = await exportStrategyBundle(state.workspace, planId, {
      authorName: state.collaboration.activeAuthorName,
      corpus: corpusBundleAccess(),
    });
    downloadBlob(blob, filename);
    log(`Saved ${filename}${photoCount ? ` (${photoCount} image${photoCount === 1 ? '' : 's'})` : ''}.`);
  } catch (err) {
    console.error(err);
    log(`Export failed: ${err.message}`);
  }
}

subscribe(state, renderAll);
subscribe(state, queueCollaborationSave);

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
          entityList.setSelection({ partId: null, conditionId: null });
          resetChatScope();
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
    await registerProject({ sourceType: 'upload' });
  } catch (err) {
    console.error(err);
    log(`Load failed: ${err.message}`);
  }
  e.target.value = '';
});

// Condition coordinates are metres; three decimals is one millimetre.
function round3(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n;
}

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
  if (!v.ok) { log(`Validation failed: ${v.errors[0]}`); return false; }
  ws = ensureFirstStrategy(ws);
  state.workspace = ws;
  state.history = [];
  state.future = [];
  selectedStepId = null;
  state.listeners.forEach(fn => fn(ws, { type: 'load-workspace' }));
  // Reset chat to global scope and pick up any seeded conversation in the
  // freshly loaded workspace.
  resetChatScope();
  chatSheet.refresh();
  return true;
}

/**
 * Guarantee an artefact always arrives with somewhere to put an intent.
 *
 * In schema v2.1 intent and constraints live on the plan, not the workspace —
 * that is what makes two strategies on one artefact genuinely divergent. The
 * consequence is that a workspace with no strategy has nowhere to record an
 * intent at all. The radar still accepted input in that state and quietly
 * stashed it in a hidden `_pendingIntent` root field, to be promoted onto
 * whichever strategy got created next. It worked, invisibly, which is the
 * worst way for something to work.
 *
 * Seeding one strategy on load removes the dead state entirely: the radar,
 * the constraints form and the action graph always have an owner. This runs
 * before the listeners fire, so it is part of the loaded state rather than an
 * undoable action — Ctrl+Z can never strand you with no strategy.
 *
 * Only artefacts get one. An empty workspace has nothing to plan against.
 */
function ensureFirstStrategy(ws) {
  if ((ws.plans || []).length) return ws;
  if (!(ws.instance?.parts || []).length) return ws;

  const plan = newPlan({ label: 'Strategy 1' });
  plan.color = pickStrategyColor([]);
  // Carry over anything the radar stashed before a strategy existed, for
  // workspaces written by an older build.
  if (ws._pendingIntent) plan.intent = { ...plan.intent, ...ws._pendingIntent };
  if (ws._pendingConstraints) plan.constraints = { ...plan.constraints, ...ws._pendingConstraints };

  const next = { ...ws, plans: [plan], currentPlanId: plan.id };
  delete next._pendingIntent;
  delete next._pendingConstraints;
  return next;
}

$('download-state-btn').onclick = async () => {
  try {
    const ws = state.workspace;
    if (!(ws.plans || []).length) {
      log('Nothing to export yet — create a strategy first.');
      return;
    }

    // Export is per-strategy (see views/strategy-picker.js). With one strategy
    // the picker resolves immediately; with several it asks which.
    const planId = await showStrategyPicker(ws, {
      authorName: state.collaboration.activeAuthorName,
    });
    if (!planId) return;

    const plan = ws.plans.find(p => p.id === planId);
    log(`Bundling "${plan?.label || 'strategy'}"…`);
    const { blob, filename, photoCount } = await exportStrategyBundle(ws, planId, {
      authorName: state.collaboration.activeAuthorName,
      corpus: corpusBundleAccess(),
    });
    downloadBlob(blob, filename);
    log(`Saved ${filename}${photoCount ? ` (${photoCount} image${photoCount === 1 ? '' : 's'})` : ''}.`);
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
    await registerProject({
      projectId: exampleProjectId(slug),
      sourceType: 'example',
      sourceRef: slug,
    });
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
  if (!confirm('Reset workspace? This clears all parts, conditions, and plans.')) return;
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
  resetChatScope();
  chatSheet.refresh();
  // A reset is a new project, not the absence of one.
  resetProjectIdentity();
  log('Workspace reset.');
};

// One action, always the same one: hand someone the link. If they open it,
// they are in the project — that is what "sharing" means here.
$('start-shared-project-btn').onclick = async () => {
  if (!state.collaboration.projectId) {
    await registerProject({ sourceType: 'custom' });
  }
  await copySharedProjectLink();
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

async function getPersistedPhoto(evidenceId) {
  const local = await PhotoStorage.get(evidenceId);
  if (local || !state.collaboration.projectId) return local || null;
  const remote = await CollaborationApi.getEvidence(state.collaboration.projectId, evidenceId);
  if (!remote) return null;
  await PhotoStorage.put(evidenceId, remote.blob, remote.name);
  return PhotoStorage.get(evidenceId);
}

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
  evidence.mimeType = blob.type || 'image/jpeg';
  evidence.capturedBy = state.collaboration.activeAuthorName || null;

  await PhotoStorage.put(evidence.id, blob, file.name);
  const isSharedConditionPhoto = !!(
    state.collaboration.projectId
    && state.collaboration.activeAuthorName
    && state.collaboration.scope === 'mine'
    && !state.collaboration.readOnly
    && attachedTo?.type === 'condition'
  );
  if (isSharedConditionPhoto) {
    setCollaborationStatus('Uploading photo…', 'saving');
    try {
      await CollaborationApi.uploadEvidence(
        state.collaboration.projectId,
        evidence,
        blob,
        state.collaboration.activeAuthorName,
      );
      evidence.url = `cloud://${state.collaboration.projectId}/${evidence.id}`;
    } catch (error) {
      console.error(error);
      setCollaborationStatus(`Photo kept locally · ${error.message}`, 'error');
      log(`Photo cloud upload failed: ${error.message}`);
    }
  }
  apply(state, { type: 'add-evidence', payload: { evidence } });
  if (isSharedConditionPhoto && evidence.url.startsWith('cloud://')) {
    await saveCurrentConditionLayer();
  }
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
      // 'part' / 'condition' / 'step' → { type, id }
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
  // target is { type: 'part'|'condition', id }
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
  getPhotoBlob: id => getPersistedPhoto(id),
  dispatch: cmd => apply(state, cmd),
  onAttachPhoto: target => attachPhotoToEntity(target),
  canEditCondition: () => !state.collaboration?.readOnly,
  onMarkComplete: stepId => markStepComplete(stepId)
});

let lastDetailTarget = null;

function openDetail(target) {
  if (!target) return;
  lastDetailTarget = target;
  // Update selections in the rest of the UI as a side effect
  if (target.type === 'part') {
    if (viewer3D) viewer3D.select({ partId: target.id });
    entityList.setSelection({ partId: target.id, conditionId: null });
    chatSheet.setScope('part', target.id);
  } else if (target.type === 'condition') {
    const h = (state.workspace.conditions || []).find(x => x.id === target.id);
    if (viewer3D) viewer3D.select({ conditionId: target.id, partId: h?.partRef });
    entityList.setSelection({ partId: null, conditionId: target.id });
    chatSheet.setScope('condition', target.id);
  } else if (target.type === 'step') {
    selectedStepId = target.id;
    actionGraph.setCurrentStep(target.id);
    chatSheet.setScope('step', target.id);
  }
  detailEditor.open(target);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// -------------------------------------------------------------------------
// Phase B: plan enrichment (background)
//
// When a chat turn creates a plan (see onApplyCommands above), this kicks
// off a secondary AI call that fills in operational + reflective fields
// per step. Runs entirely in the background — UI shows a small spinner on
// each step until the enrichment arrives.
// -------------------------------------------------------------------------

// Set of step IDs that currently have an enrichment in flight. Views read
// this via getEnrichingStepIds() to render the "thinking" indicator.
const enrichingStepIds = new Set();
let enrichmentSeq = 0;

export function getEnrichingStepIds() { return enrichingStepIds; }
// Expose globally so view files that don't import main.js can still query.
window.__getEnrichingStepIds = () => enrichingStepIds;

/**
 * Is this plan worth spending an enrichment call on?
 *
 * The chat model sometimes writes fully-detailed steps itself. Re-enriching
 * those burns a call and replaces the model's own reasoning with a weaker
 * re-derivation. estimatedMinutes and justification.rationale are the
 * marker fields: if not a single step carries either, the plan is a bare
 * skeleton and Phase B adds real information.
 */
function needsEnrichment(plan) {
  const steps = plan?.steps || [];
  if (!steps.length) return false;
  return !steps.some(s => s.estimatedMinutes != null || s.justification?.rationale);
}

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
//
// NOTE: currently has no caller. Its only entry point was the "mark
// complete" quick-action chip, which went away with the propose stack
// (the chip row was never visible anyway — it was display:none in the
// markup). Kept because the execution-log flow itself is intact and
// still wants a UI affordance; whatever surfaces it next can call this
// as-is.
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

// Object URLs minted by the imagine section and the source picker.
//
// renderImagineSection runs from renderAll(), which fires on EVERY state
// change — every keystroke commit, every chat message, every slider release.
// Each pass minted a fresh blob URL per rendering and never revoked one, so a
// long session leaked the full byte size of every generated image many times
// over. On a phone that is the difference between a working session and a
// crashed tab. Revoke the previous generation before minting the next.
const imagineObjectUrls = new Set();

function imagineUrl(blob) {
  const url = URL.createObjectURL(blob);
  imagineObjectUrls.add(url);
  return url;
}

function releaseImagineUrls() {
  // The lightbox holds a URL of its own while open; revoking underneath it
  // would blank the image the user is looking at.
  const lightboxOpen = !!document.querySelector('.image-lightbox');
  if (lightboxOpen) return;
  for (const url of imagineObjectUrls) URL.revokeObjectURL(url);
  imagineObjectUrls.clear();
}

function renderImagineSection(ws) {
  releaseImagineUrls();
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
      const url = imagineUrl(photo.blob);
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
    const url = imagineUrl(photo.blob);
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
        const url = imagineUrl(p.blob);
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

  // The source photo's BYTES are not needed to refine — only its id, to stamp
  // the new rendering's provenance below. Loading it used to be a hard
  // precondition, which meant refining failed on any device that had not
  // captured the photo itself: evidence records travel in the participant's
  // layer, but the blobs live in this browser's IndexedDB. Same person, second
  // device, no refinement.
  const prevImage = await PhotoStorage.get(previousRendering.id);
  if (!prevImage) { alert('Previous rendering file not on this device.'); return; }

  // These controls belong to the imagine panel, which may not be rendered at
  // all when a refinement is driven from chat — the panel only exists once a
  // rendering is on screen for the current strategy. Optional throughout.
  const btn = $('imagine-refine-btn');
  const input = $('imagine-refine-input');
  const setBtn = (label, disabled) => { if (btn) { btn.textContent = label; btn.disabled = disabled; } };
  if (input) input.disabled = true;
  setBtn('⏳ Modifying target…', true);
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

    // Stage 2: generate the new image from the previous rendering.
    //
    // A refinement anchors on the previous rendering ALONE — the endpoint
    // discards the source photo on this path, because sending both made the
    // model interpolate between them. So we no longer upload the source at
    // all: it was 200-500 KB base64'd and thrown away on every refine.
    setBtn('⏳ Generating image…', true);
    const prevBase64 = await blobToBase64(prevImage.blob);

    const genResp = await fetch('/api/imagine-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
    postRenderingToChat(rendering, `Revised the image: "${userInstruction}".${rationale ? " " + rationale : ""}`);
    log(`Refined imagined result → ${rendering.id}`);
  } catch (err) {
    console.error('[refine] failed:', err);
    alert('Refinement failed: ' + err.message);
  } finally {
    setBtn('↻ Refine image', false);
    if (input) { input.disabled = false; input.value = ''; }
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
  await attachExamplePhotos(slug);
  await attachExampleMesh(slug);
  rememberExampleSlug(slug);
}

// Walk the workspace's photo-kind evidence records and try to fetch each
// from the example's /photos/ folder. Hits are seeded into IndexedDB
// under the evidence id so the "Pick source photo" dialog and the
// imagine-result pipeline can find them.
//
// Example workspaces declare photos by evidence record only (id +
// filename) because bundling base64 blobs into workspace.json would
// inflate it by megabytes per photo. Keeping the actual JPEGs as
// loose files alongside the JSON is much cleaner.
//
// File naming convention varies across examples: some use the workspace's
// fileName field directly, some name the file after the evidence id with
// a generic .jpg extension. We try fileName first, then a few id-based
// fallbacks. Records that can't be found are skipped silently — the
// existing "missing" affordance in the picker handles them.
async function attachExamplePhotos(slug) {
  const ws = state.workspace;
  const photos = (ws.evidence || []).filter(e => e.kind === 'photo');
  if (!photos.length) return;
  for (const ev of photos) {
    try {
      // Skip if it's already in IndexedDB (e.g. user re-loaded the example).
      const existing = await PhotoStorage.get(ev.id);
      if (existing) continue;
      const candidates = [];
      if (ev.fileName) candidates.push(ev.fileName);
      for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'JPG', 'JPEG', 'PNG']) {
        candidates.push(`${ev.id}.${ext}`);
      }
      let blob = null;
      let foundName = null;
      for (const name of candidates) {
        try {
          const res = await fetch(`/examples/${slug}/photos/${encodeURIComponent(name)}`);
          if (res.ok) {
            blob = await res.blob();
            foundName = name;
            break;
          }
        } catch { /* try next */ }
      }
      if (!blob) continue;
      await PhotoStorage.put(ev.id, blob, ev.fileName || foundName);
    } catch (err) {
      console.warn(`[example] could not load photo ${ev.fileName || ev.id}:`, err);
    }
  }
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

// Try /examples/<slug>/cover.{jpg,jpeg,png,webp} in order. Small covers are
// embedded as data URLs so they travel with exports. Large example covers
// keep their static URL; embedding multi-megabyte photos can exceed both
// localStorage and D1 project-row limits.
async function attachExampleCover(slug) {
  for (const ext of COVER_EXTS) {
    try {
      const assetUrl = `/examples/${slug}/cover.${ext}`;
      const res = await fetch(assetUrl);
      if (!res.ok) continue;
      const blob = await res.blob();
      const coverImage = blob.size > 500_000 ? assetUrl : await blobToDataUrl(blob);
      // Mutate via the same channel as other workspace edits so
      // autoPersist captures it and renderAll re-runs.
      state.workspace = {
        ...state.workspace,
        instance: { ...state.workspace.instance, coverImage }
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
        const url = imagineUrl(photo.blob);
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
    postRenderingToChat(rendering, 'Imagined the repaired state from the current target description.');
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

/**
 * Regenerate the imagined result because the participant objected to it.
 *
 * Reuses the refinement pipeline rather than duplicating it: the instruction
 * goes through modify-target-json to update the Soll, and the image follows
 * from the updated Soll. Keeping the Soll in the loop is what makes this
 * precise — the objection is resolved against a structured description of the
 * target state, not against the image model's memory of the last picture.
 */
async function runRenderRequest(instruction, planId) {
  const ws = state.workspace;
  const targetPlan = planId || ws.currentPlanId;

  const renderings = (ws.evidence || [])
    .filter(e => e.kind === 'rendering' && e.planRef === targetPlan && e.sollJson)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const latest = renderings[0];
  if (!latest) {
    // Nothing to revise. Say so in the thread rather than failing silently —
    // the assistant has just told the participant an image is coming.
    log('No imagined result yet for this strategy — generate one first, then it can be revised.');
    return;
  }
  await runRefineImage(latest, instruction);
}

/**
 * Put a generated image into the strategy's conversation.
 *
 * An imagined result is the answer to something someone asked for, and it
 * belongs where they asked — not only in a side panel they have to go and
 * look at. Posting it into the strategy thread also gives the next turn
 * something to refer to: "the new timber looks too orange" only means
 * anything if the image is in the conversation.
 *
 * Targets the plan's thread directly rather than going through the chat
 * sheet's current scope, so generating an image never changes which
 * conversation the participant is reading.
 */
function postRenderingToChat(rendering, text) {
  const planId = rendering.planRef || state.workspace.currentPlanId || null;
  if (!planId) return;

  const findThread = () => (state.workspace.conversations || [])
    .find(t => t.scope === 'plan' && (t.ref ?? null) === planId);

  if (!findThread()) {
    apply(state, { type: 'start-conversation', payload: { scope: 'plan', ref: planId } }, { skipHistory: true });
  }
  const thread = findThread();
  if (!thread) return;

  const msg = newMessage('assistant', text);
  msg.renderingId = rendering.id;
  // skipHistory: an image already costs a command for its evidence record.
  // Ctrl+Z should undo the rendering, not peel a narration line off first.
  apply(state, { type: 'append-message', payload: { threadId: thread.id, message: msg } }, { skipHistory: true });
  chatSheet?.refresh?.();
}

// -------------------------------------------------------------------------
// Corpus — source material the AI reads
//
// Two tiers. Project documents are shared by everyone working on this artefact:
// user-independent on purpose, so divergence between participants comes from
// what they do with the material rather than from having different material.
// Strategy documents belong to one strategy and are invisible to the others,
// which is what makes two strategies reason from genuinely different evidence.
// -------------------------------------------------------------------------

let corpus = null;
let pendingCorpusScope = 'project';

function ensureCorpus() {
  if (corpus) return corpus;
  corpus = createCorpus({
    api: CollaborationApi,
    getProjectId: () => state.collaboration.projectId,
    getScope: () => ({
      planId: state.workspace.currentPlanId || null,
      authorKey: state.collaboration.activeAuthorKey || null,
      authorName: state.collaboration.activeAuthorName || null,
    }),
    log,
  });
  return corpus;
}

function setCorpusStatus(message) {
  const el = $('corpus-status');
  if (el) el.textContent = message || '';
}

async function renderCorpus() {
  const projectList = $('corpus-project-list');
  const strategyList = $('corpus-strategy-list');
  if (!projectList || !strategyList) return;

  if (!state.collaboration.projectId) {
    projectList.innerHTML = '<div class="entity-empty">Load an artefact first.</div>';
    strategyList.innerHTML = '';
    return;
  }

  let docs = [];
  try {
    docs = await ensureCorpus().list();
  } catch (err) {
    projectList.innerHTML = `<div class="entity-empty">Corpus unavailable — ${escapeAttr(err.message)}</div>`;
    strategyList.innerHTML = '';
    return;
  }

  const planId = state.workspace.currentPlanId;
  const project = docs.filter(d => d.scope === 'project');
  const strategy = docs.filter(d => d.scope === 'strategy' && d.planId === planId);

  projectList.innerHTML = project.length
    ? project.map(corpusRow).join('')
    : '<div class="entity-empty">Nothing yet. Add the survey, drawings, or the brief.</div>';
  strategyList.innerHTML = strategy.length
    ? strategy.map(corpusRow).join('')
    : '<div class="entity-empty">Nothing yet. Documents added here are read by this strategy alone.</div>';

  for (const el of [projectList, strategyList]) {
    el.querySelectorAll('[data-remove-doc]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.dataset.removeDoc;
        const doc = docs.find(d => d.id === id);
        if (!confirm(`Remove "${doc?.filename || id}" from the corpus?`)) return;
        try {
          await ensureCorpus().remove(id);
          log(`Removed "${doc?.filename || id}".`);
          renderCorpus();
        } catch (err) {
          log(`Could not remove: ${err.message}`);
        }
      };
    });
  }
}

function corpusRow(d) {
  const state_ = d.status === 'ready' ? '' :
    d.status === 'failed' ? '<span class="corpus-flag err">unreadable</span>' :
    '<span class="corpus-flag">reading…</span>';
  const summary = d.summary
    ? `<div class="corpus-summary">${escapeAttr(d.summary)}</div>`
    : '';
  return `<div class="corpus-doc" title="${escapeAttr(d.filename)}">
      <div class="corpus-doc-head">
        <span class="corpus-kind">${escapeAttr(d.docKind)}</span>
        <span class="corpus-name">${escapeAttr(d.filename)}</span>
        ${state_}
        <button class="mini-btn x" data-remove-doc="${escapeAttr(d.id)}" title="Remove">×</button>
      </div>
      <div class="corpus-meta">${escapeAttr(formatSize(d.byteSize))}${d.authorName ? ' · ' + escapeAttr(d.authorName) : ''}</div>
      ${summary}
    </div>`;
}

/** Ask what role a document plays before uploading it. */
function askDocKind(scope) {
  return new Promise(resolve => {
    const modal = $('corpus-kind-modal');
    $('corpus-kind-copy').textContent = scope === 'strategy'
      ? 'This document will be read by the current strategy only — not by your other strategies, and not by other participants.'
      : 'This document will be read by everyone working on this artefact.';
    modal.classList.add('on');
    const close = value => {
      modal.classList.remove('on');
      modal.querySelectorAll('.corpus-kind-btn').forEach(b => { b.onclick = null; });
      resolve(value);
    };
    modal.querySelectorAll('.corpus-kind-btn').forEach(btn => {
      btn.onclick = () => close(btn.dataset.kind);
    });
    $('corpus-kind-close').onclick = () => close(null);
  });
}

async function addCorpusDocuments(scope) {
  if (!state.collaboration.projectId) { log('Load an artefact first.'); return; }
  if (scope === 'strategy' && !state.workspace.currentPlanId) {
    log('Select a strategy first.');
    return;
  }
  if (scope === 'strategy' && !state.collaboration.activeAuthorKey) {
    log('Choose your name first — strategy documents belong to your layer.');
    openParticipantNameModal();
    return;
  }
  pendingCorpusScope = scope;
  $('corpus-file').click();
}

$('corpus-add-project').onclick = () => addCorpusDocuments('project');
$('corpus-add-strategy').onclick = () => addCorpusDocuments('strategy');

$('corpus-file').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  const scope = pendingCorpusScope;
  const docKind = await askDocKind(scope);
  if (!docKind) return;

  for (const file of files) {
    setCorpusStatus(`Reading ${file.name}…`);
    log(`Adding "${file.name}"…`);
    try {
      await ensureCorpus().add(file, {
        scope,
        docKind,
        artefactName: state.workspace.instance?.name || null,
      });
    } catch (err) {
      console.error(err);
      log(`Could not add "${file.name}": ${err.message}`);
    }
    await renderCorpus();
  }
  setCorpusStatus('');
});

// -------------------------------------------------------------------------
// Shared condition layers (Cloudflare Worker + D1)
// -------------------------------------------------------------------------

function setCollaborationStatus(message, status = 'idle', onClick = null) {
  const el = $('collab-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = status;
  // Assignment rather than addEventListener: this runs on every state change,
  // and listeners would stack up one per save.
  el.onclick = onClick;
  el.classList.toggle('actionable', !!onClick);
  el.title = onClick ? 'Click to resolve' : '';
  state.collaboration.syncState = status;
}

function updateCollaborationUi() {
  const collab = state.collaboration;
  const active = !!collab.projectId;
  $('collab-controls').hidden = !active;
  $('collab-project-title').textContent = collab.projectTitle || state.workspace.instance?.name || 'Untitled project';
  $('collab-author-btn').textContent = collab.activeAuthorName || 'Choose name';
  $('collab-mine-btn').classList.toggle('active', collab.scope === 'mine');
  $('collab-all-btn').classList.toggle('active', collab.scope === 'all');
  $('new-condition-btn').disabled = !!collab.readOnly;
  $('new-condition-btn').title = collab.readOnly ? 'Switch to My conditions to add an observation' : '';
  const shareBtn = $('start-shared-project-btn');
  shareBtn.innerHTML = '<span>🔗</span> Copy project link';
  shareBtn.disabled = !(state.workspace.instance?.parts || []).length;
  shareBtn.title = shareBtn.disabled
    ? 'Load or create an artefact first'
    : 'Copy a link that opens this project';
}


function openParticipantNameModal() {
  if (!state.collaboration.projectId) return;
  $('collab-name-error').textContent = '';
  $('collab-name-input').value = state.collaboration.activeAuthorName || '';
  $('collab-name-modal').classList.add('on');
  setTimeout(() => $('collab-name-input').focus(), 30);
  renderParticipantRoster();
}

/**
 * Show who is already in this project before someone types a name.
 *
 * With ten people on one artefact, a name IS the identity — two participants
 * who both type "Anna" share one layer and snapshot-replace each other's work.
 * Nothing in the system can detect that after the fact, so the defence has to
 * be showing the roster at the moment of choosing: seeing "Anna M. — 12
 * conditions · 2 strategies" listed is what stops the second Anna walking into
 * it. Clicking a name also reopens that layer, which is how you look at a
 * colleague's survey.
 */
async function renderParticipantRoster() {
  const box = $('collab-roster');
  if (!box) return;
  box.hidden = true;
  box.innerHTML = '';
  if (!state.collaboration.projectId) return;

  let roster = [];
  try {
    roster = await CollaborationApi.getLayerRoster(state.collaboration.projectId);
  } catch {
    return;   // offline: the prompt still works, it just can't advise
  }
  if (!roster.length) return;

  const rows = roster.map(r => {
    const c = r.counts || {};
    const meta = [
      `${c.conditions || 0} condition${c.conditions === 1 ? '' : 's'}`,
      `${c.plans || 0} strateg${c.plans === 1 ? 'y' : 'ies'}`,
    ].join(' · ');
    return `<button type="button" class="roster-row" data-name="${escapeAttr(r.authorName)}">
        <span class="roster-name">${escapeAttr(r.authorName)}</span>
        <span class="roster-meta">${escapeAttr(meta)}</span>
      </button>`;
  }).join('');

  box.innerHTML = `<div class="roster-label">Already in this project — tap to reopen</div>${rows}`;
  box.hidden = false;
  box.querySelectorAll('.roster-row').forEach(btn => {
    btn.onclick = () => { $('collab-name-input').value = btn.dataset.name; };
  });
}

function closeParticipantNameModal() {
  $('collab-name-modal').classList.remove('on');
  $('collab-name-error').textContent = '';
}

/**
 * Register this workspace with the backend under its project id.
 *
 * There is no "start sharing" act. A workspace IS a project from the moment it
 * has an artefact; the id is its identity. Anyone who opens the same id — a
 * colleague on their laptop, you on your phone — is working on the same
 * project, and their name selects which layer within it. That is the whole
 * model.
 *
 * The previous design made sharing a state transition you had to trigger,
 * which meant the same workspace could be "shared" or "not shared" and behaved
 * differently in each case. It also fired silently on example and file load,
 * so most people ended up in the shared state without choosing it — the worst
 * of both arrangements.
 *
 * Registration is best-effort and silent: if the worker is unreachable the
 * project keeps its id and the participant keeps working locally.
 */
async function registerProject({ projectId = null, sourceType = 'custom', sourceRef = null } = {}) {
  if (!state.workspace.instance?.parts?.length) return false;
  const id = projectId || state.workspace.collaboration?.projectId || createProjectId();

  // Adopt the identity FIRST, then tell the backend about it.
  //
  // The project panel and the name prompt used to appear only after
  // ensureProject() resolved, so anything that stopped that call from
  // resolving — no VITE_COLLAB_API_URL, no `wrangler dev` behind the dev
  // proxy, a hung request — left the participant with no visible project and
  // no way to enter a name at all. But a project id is a local fact: the
  // workspace has one whether or not a server has heard about it yet.
  state.collaboration.projectId = id;
  state.collaboration.scope = 'mine';
  state.collaboration.readOnly = false;
  const initialUrl = new URL(window.location.href);
  initialUrl.searchParams.set('project', id);
  history.replaceState(null, '', initialUrl);
  updateCollaborationUi();
  setCollaborationStatus('Connecting…', 'saving');

  const baseWorkspace = projectTemplate(state.workspace, id);
  try {
    const project = await CollaborationApi.ensureProject({
      projectId: id,
      title: state.workspace.instance?.name || 'Untitled project',
      baseWorkspace,
      sourceType,
      sourceRef,
    });
    state.collaboration.projectId = project.id;
    state.collaboration.projectTitle = project.title;
    state.collaboration.scope = 'mine';
    state.collaboration.readOnly = false;
    collaborationSuppressSync = true;
    state.workspace = { ...state.workspace, collaboration: { projectId: project.id, modelVersion: project.modelVersion || '1' } };
    state.listeners.forEach(fn => fn(state.workspace, { type: 'collaboration-project-opened' }));
    collaborationSuppressSync = false;
    const url = new URL(window.location.href);
    url.searchParams.set('project', project.id);
    history.replaceState(null, '', url);
    updateCollaborationUi();
    // Identity is remembered per project, so a returning participant is not
    // asked again. Only a project this browser has never named itself in
    // prompts for a name.
    await resumeParticipantIdentity(id);
    return true;
  } catch (error) {
    // Offline, or the worker is down. The workspace keeps its id, the panel
    // stays visible and a name can still be chosen — the layer simply syncs
    // later. Nothing is lost and nothing is blocked.
    console.warn('Project registration failed:', error.message);
    // Stamp the id onto the workspace anyway. It only used to be recorded on
    // the success path, so a registration that failed left nothing behind —
    // and the next reload had no project to reattach to, which is why the
    // project panel and the name control vanished after a refresh.
    collaborationSuppressSync = true;
    state.workspace = { ...state.workspace, collaboration: { projectId: id, modelVersion: '1' } };
    state.listeners.forEach(fn => fn(state.workspace, { type: 'collaboration-project-opened' }));
    collaborationSuppressSync = false;
    updateCollaborationUi();
    await resumeParticipantIdentity(id);
    if (!state.collaboration.activeAuthorName) {
      setCollaborationStatus('Offline — choose a name to work locally', 'error');
    }
    return false;
  }
}

async function loadSharedProject(projectId) {
  setCollaborationStatus('Loading shared project…', 'saving');
  try {
    const project = await CollaborationApi.getProject(projectId);
    if (!project?.baseWorkspace) throw new Error('Shared project has no workspace');
    if (!loadWorkspaceJson(project.baseWorkspace)) {
      throw new Error('Shared project contains an invalid workspace');
    }
    if (project.sourceType === 'example' && project.sourceRef) {
      await attachExampleAssets(project.sourceRef);
    }
    state.collaboration.projectId = project.id;
    state.collaboration.projectTitle = project.title;
    state.collaboration.scope = 'mine';
    state.collaboration.readOnly = false;
    updateCollaborationUi();
    await resumeParticipantIdentity(project.id);
    return true;
  } catch (error) {
    console.error(error);
    log(`Could not open project: ${error.message}`);
    setCollaborationStatus(error.message, 'error');
    return false;
  }
}

/**
 * Adopt a participant identity and load that person's condition layer.
 *
 * `silent: true` is the reload path — the name came from this browser's stored
 * identity rather than from the modal, so there is no form to disable and a
 * network failure must not strand the participant behind an error dialog.
 */
async function loadParticipantConditions(authorName, { silent = false } = {}) {
  const name = normalizeAuthorName(authorName);
  const key = normalizeAuthorKey(name);
  if (!name || !key) return;
  const submit = $('collab-name-submit');
  if (!silent) {
    submit.disabled = true;
    $('collab-name-error').textContent = '';
  }
  setCollaborationStatus(`Loading ${name}…`, 'saving');

  // Adopt the identity before touching the network. Who you are is a local
  // decision; the layer is what syncs. Gating adoption on a successful fetch
  // used to strand the participant in the name modal whenever the worker was
  // unreachable, unable to record anything even locally.
  const previousAuthor = state.collaboration.activeAuthorName;
  if (previousAuthor && previousAuthor !== name) {
    try { await saveCurrentConditionLayer(); }
    catch (err) { console.warn('Could not flush the outgoing layer:', err.message); }
  }

  state.collaboration.activeAuthorName = name;
  state.collaboration.activeAuthorKey = key;
  state.collaboration.scope = 'mine';
  state.collaboration.readOnly = false;
  saveIdentity(state.collaboration.projectId, { authorName: name, authorKey: key });
  closeParticipantNameModal();
  updateCollaborationUi();

  const sync = ensureLayerSync();
  try {
    const { layer, meta } = await CollaborationApi.getLayer(state.collaboration.projectId, key);
    // Record the revision we read, so our first write is based on it rather
    // than blindly overwriting whatever arrived in between.
    sync.setRevision(meta?.rev || 0);

    if (layer) {
      applyParticipantLayer(layer, 'collaboration-author-loaded');
      const nPlans = (state.workspace.plans || []).length;
      const nConds = (state.workspace.conditions || []).length;
      log(`Working as ${name}: ${nConds} condition${nConds === 1 ? '' : 's'}, ${nPlans} strateg${nPlans === 1 ? 'y' : 'ies'}.`);
      renderSyncState(SYNC_STATE.IDLE);
    } else {
      // A participant with no layer yet keeps the project's seed artefact and
      // starts an empty survey on it.
      applyParticipantLayer({ conditions: [], evidence: [], executionLog: [] }, 'collaboration-author-loaded');
      log(`Working as ${name}: new layer.`);
      renderSyncState(SYNC_STATE.IDLE);
    }
  } catch (error) {
    // Offline. Critically, do NOT clear the workspace — an empty response and
    // an unreachable server are not the same thing, and treating them alike
    // would erase work already on this device.
    console.warn('Could not load the layer:', error.message);
    setCollaborationStatus(`Offline as ${name} — saved on this device`, 'error');
    log(`Offline: working locally as ${name}.`);
  } finally {
    if (!silent) submit.disabled = false;
  }
}

/**
 * Everyone's conditions, read-only.
 *
 * Conditions only — not strategies. Strategies stay private while people are
 * working: seeing someone else's plan is the fastest way to converge on it,
 * and divergence is the point of the exercise. Comparison happens afterwards.
 */
async function showAllSharedConditions() {
  if (!state.collaboration.projectId || !state.collaboration.activeAuthorName) {
    openParticipantNameModal();
    return;
  }
  setCollaborationStatus('Loading all conditions…', 'saving');
  try {
    await saveCurrentConditionLayer();
    const roster = await CollaborationApi.getLayerRoster(state.collaboration.projectId);
    const layers = await Promise.all(
      roster.map(r => CollaborationApi.getLayer(state.collaboration.projectId, r.authorKey)
        .then(res => ({ meta: r, layer: res.layer }))
        .catch(() => null)),
    );

    const conditions = [];
    const evidence = [];
    for (const entry of layers.filter(Boolean)) {
      for (const c of entry.layer?.conditions || []) {
        conditions.push({ ...c, authorName: c.authorName || entry.meta.authorName });
      }
      for (const e of entry.layer?.evidence || []) {
        if (e?.attachedTo?.type === 'condition') evidence.push(e);
      }
    }

    collaborationSuppressSync = true;
    state.collaboration.scope = 'all';
    state.collaboration.readOnly = true;
    state.workspace = {
      ...state.workspace,
      conditions,
      evidence: [
        ...(state.workspace.evidence || []).filter(e => e.attachedTo?.type !== 'condition'),
        ...evidence,
      ],
      updatedAt: new Date().toISOString(),
    };
    state.history = [];
    state.future = [];
    state.listeners.forEach(fn => fn(state.workspace, { type: 'collaboration-all-loaded' }));
    collaborationSuppressSync = false;

    updateCollaborationUi();
    const people = layers.filter(Boolean).length;
    setCollaborationStatus(`${conditions.length} condition${conditions.length === 1 ? '' : 's'} from ${people} participant${people === 1 ? '' : 's'} · read-only`, 'idle');
    log(`Showing all conditions from ${people} participant${people === 1 ? '' : 's'}.`);
  } catch (error) {
    console.error(error);
    setCollaborationStatus(error.message, 'error');
    log(`Could not load all conditions: ${error.message}`);
  }
}

async function showMySharedConditions() {
  if (!state.collaboration.activeAuthorName) {
    openParticipantNameModal();
    return;
  }
  await loadParticipantConditions(state.collaboration.activeAuthorName);
}

/**
 * The participant's layer — their parts model, conditions, strategies,
 * evidence, conversations and execution log — synced as one unit.
 *
 * Previously only conditions reached the server. Strategies, which are the
 * actual output of the exercise, lived in one browser and were lost on a
 * device change. See core/layer-sync.js for the debounce, retry, revision and
 * flush-on-exit behaviour.
 */
function ensureLayerSync() {
  if (layerSync) return layerSync;
  layerSync = createLayerSync({
    api: CollaborationApi,
    getWorkspace: () => state.workspace,
    getContext: () => ({
      projectId: state.collaboration.projectId,
      authorName: state.collaboration.activeAuthorName,
      authorKey: state.collaboration.activeAuthorKey,
      readOnly: state.collaboration.readOnly || state.collaboration.scope !== 'mine',
    }),
    onState: (syncState, detail) => renderSyncState(syncState, detail),
    log,
  });
  layerSync.attachLifecycle(window);
  return layerSync;
}

/**
 * Resolve a layer conflict, by choice rather than by rule.
 *
 * Cancel does nothing on purpose: dismissing a dialog with Escape must never
 * be the path that discards someone's work. Taking the other version means
 * reloading, which the participant does themselves once they have decided.
 */
async function resolveLayerConflict() {
  if (!layerSync) return;
  const ok = confirm(
    'This layer was changed somewhere else — another tab, or another device.\n\n'
    + 'Overwrite it with the version on this screen?\n\n'
    + 'Cancel leaves both as they are. Either way your work stays in this browser, '
    + 'and you can save a ZIP from the Save button at any time.\n\n'
    + 'To take the other version instead, cancel and reload the page.',
  );
  if (!ok) return;
  setCollaborationStatus('Overwriting…', 'saving');
  const result = await layerSync.overwriteRemote();
  if (!result?.ok) {
    setCollaborationStatus('Could not overwrite — still changed elsewhere', 'error', resolveLayerConflict);
  }
}

function renderSyncState(syncState, detail) {
  const counts = state.workspace;
  const n = (counts.conditions || []).length;
  const p = (counts.plans || []).length;
  const summary = `${n} condition${n === 1 ? '' : 's'} · ${p} strateg${p === 1 ? 'y' : 'ies'}`;
  switch (syncState) {
    case SYNC_STATE.PENDING:
      setCollaborationStatus(`${summary} · unsaved`, 'saving');
      break;
    case SYNC_STATE.SAVING:
      setCollaborationStatus(`${summary} · saving…`, 'saving');
      break;
    case SYNC_STATE.CONFLICT:
      // The old wording promised something the code could not do: after a
      // conflict every ordinary save carries the same stale revision and
      // conflicts again, so "save again" left the participant permanently
      // unable to reach the server. Overwriting has to be a decision someone
      // makes, and it has to be reachable.
      setCollaborationStatus('Changed elsewhere — click to resolve', 'error', resolveLayerConflict);
      break;
    case SYNC_STATE.OFFLINE:
      setCollaborationStatus(`${summary} · offline, kept on this device`, 'error');
      break;
    default:
      setCollaborationStatus(`${summary} · saved`, 'idle');
  }
}

function queueCollaborationSave(workspace, event) {
  if (collaborationSuppressSync) return;
  if (event?.type?.startsWith('collaboration-')) return;
  ensureLayerSync().queue();
}

/** Flush any pending write. Used before switching participant. */
async function saveCurrentConditionLayer() {
  if (!layerSync) return;
  await layerSync.flush();
}

/**
 * Load a participant's layer and make it the working state.
 *
 * Replaces the whole workspace, not just conditions: the layer now carries the
 * parts model and strategies too.
 */
function applyParticipantLayer(layer, eventType) {
  collaborationSuppressSync = true;
  state.workspace = applyLayer(state.workspace, layer);
  state.history = [];
  state.future = [];
  selectedStepId = null;
  state.listeners.forEach(fn => fn(state.workspace, { type: eventType }));
  collaborationSuppressSync = false;
  resetChatScope();
  chatSheet.refresh();
}

async function copySharedProjectLink() {
  if (!state.collaboration.projectId) return;
  const link = projectShareUrl(state.collaboration.projectId);
  try {
    await navigator.clipboard.writeText(link);
    setCollaborationStatus('Project link copied', 'idle');
  } catch {
    window.prompt('Copy this project link:', link);
  }
}

// Detach from the current project. Used by Reset: the fresh workspace has no
// artefact yet, so it gets its id when one is loaded or created.
function resetProjectIdentity() {
  layerSync = null;
  Object.assign(state.collaboration, {
    projectId: null,
    projectTitle: '',
    activeAuthorName: '',
    activeAuthorKey: '',
    scope: 'mine',
    readOnly: false,
    syncState: 'idle',
  });
  const url = new URL(window.location.href);
  url.searchParams.delete('project');
  history.replaceState(null, '', url);
  updateCollaborationUi();
}

$('collab-name-form').addEventListener('submit', event => {
  event.preventDefault();
  loadParticipantConditions($('collab-name-input').value);
});
$('collab-name-cancel').onclick = closeParticipantNameModal;
$('collab-name-close').onclick = closeParticipantNameModal;
$('collab-author-btn').onclick = openParticipantNameModal;
$('collab-mine-btn').onclick = showMySharedConditions;
$('collab-all-btn').onclick = showAllSharedConditions;
$('collab-copy-link').onclick = copySharedProjectLink;

/**
 * Re-attach to the project named in ?project= — WITHOUT discarding local work.
 *
 * This used to call loadSharedProject() unconditionally, which fetched the
 * project's frozen baseWorkspace and replaced state.workspace wholesale. Since
 * registerProject() writes ?project= into the URL, and it runs on example
 * load and on any file upload, essentially every participant ended up in that
 * regime — so every reload destroyed every strategy, intent, constraint set
 * and chat thread created since the project was started. autoPersist then
 * overwrote localStorage with the template, making the loss permanent.
 *
 * The stored workspace is authoritative when it belongs to the same project.
 * We only fetch the template when this browser has nothing for that project.
 */
async function reattachProjectFromUrl() {
  const projectId = new URL(window.location.href).searchParams.get('project');
  if (!projectId) return false;

  const localProjectId = state.workspace?.collaboration?.projectId || null;
  const haveLocalWork = localProjectId === projectId
    && ((state.workspace.plans || []).length > 0
      || (state.workspace.conditions || []).length > 0
      || (state.workspace.instance?.parts || []).length > 0);

  if (haveLocalWork) {
    // Resume: keep the local workspace, re-establish the session around it.
    try {
      const project = await CollaborationApi.getProject(projectId);
      state.collaboration.projectTitle = project?.title || '';
    } catch (err) {
      // Offline or the worker is down — carry on locally. Work is not lost.
      console.warn('Could not reach the collaboration API on resume:', err.message);
      setCollaborationStatus('Offline — working locally', 'error');
    }
    state.collaboration.projectId = projectId;
    state.collaboration.scope = 'mine';
    state.collaboration.readOnly = false;
    updateCollaborationUi();
    await resumeParticipantIdentity(projectId);
    return true;
  }

  return loadSharedProject(projectId);
}

/**
 * Restore the participant's name from this browser instead of asking again.
 * Identity is per-project and browser-local (see core/state.js).
 */
async function resumeParticipantIdentity(projectId) {
  const remembered = loadIdentity(projectId);
  if (!remembered?.authorName) {
    // Nothing syncs until a name selects a layer, so say so rather than
    // letting someone record conditions that quietly stay on this device.
    setCollaborationStatus('Choose a name — nothing is saved to the project yet', 'idle');
    openParticipantNameModal();
    return false;
  }
  await loadParticipantConditions(remembered.authorName, { silent: true });
  return true;
}

renderAll();
setTimeout(() => viewer3D.resize(), 50);
resetChatScope();

// Rehydrate the textured mesh overlay if the previous session loaded
// an example. The slug lives in localStorage (not the workspace JSON)
// because mesh.glb is large and tied to the example folder, not the
// artefact. Silent no-op when there's nothing to rehydrate.
(async function rehydrateProject() {
  const reattached = await reattachProjectFromUrl();

  // A workspace restored from localStorage never passed through the example
  // or file-load path, so nothing had registered its project — the panel with
  // "Working as" and the My/All conditions toggle stayed hidden until you
  // loaded an example again. Every artefact belongs to a project; re-adopt it
  // (or mint one) so the controls are there on a plain refresh too.
  if (!reattached && (state.workspace.instance?.parts || []).length) {
    await registerProject({
      projectId: state.workspace.collaboration?.projectId || null,
      sourceType: recalledExampleSlug() ? 'example' : 'custom',
      sourceRef: recalledExampleSlug() || null,
    });
  }
  // The mesh overlay is tied to the example folder, not to the project, so it
  // is re-fetched on every path. Resuming a project no longer replaces the
  // workspace, so the mesh has to be restored there too — loadSharedProject
  // re-attaches its own via sourceRef, and this is a no-op when it already did.
  const slug = recalledExampleSlug();
  if (slug) await attachExampleMesh(slug);
})();

log('Workspace ready.');
