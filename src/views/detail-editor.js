/**
 * Detail editor — replaces the read-only detail modal with editable forms.
 *
 * Three entity types share this surface:
 *   - part: id, label, material, status, notes, dimensions, connections
 *   - hypothesis: type, description, status, confidence, partRef, coordinates
 *   - step: title, description, status, estimatedMinutes, expectedOutcome,
 *           tools, materials, rationale
 *
 * Each change is dispatched through the apply() pipeline so undo works.
 * Photos attached to a hypothesis (via add-evidence with attachedTo) are
 * rendered as thumbnails below the form; clicking opens a full-size view.
 *
 * The Delete button on hypotheses dispatches remove-hypothesis with a
 * confirmation prompt.
 */

import { PART_STATUS, HYPOTHESIS_STATUS, STEP_STATUS } from '../core/schema.js';
import { createMiniViewer3D } from './mini-viewer-3d.js';

export function createDetailEditor({ modalEl, titleEl, bodyEl, getWorkspace, getPhotoBlob, dispatch, onAttachPhoto }) {

  // The mini-3D-viewer is created on demand inside the modal body. We
  // destroy and recreate it each time the modal opens to avoid context
  // leaks; Three.js WebGL contexts are expensive to keep around.
  let miniViewer = null;
  // Tracks a queued rAF that will create a viewer next frame. Set when
  // build is called, cleared when the callback fires or the modal closes.
  let pendingViewerRaf = null;

  function destroyMiniViewer() {
    if (pendingViewerRaf) {
      cancelAnimationFrame(pendingViewerRaf);
      pendingViewerRaf = null;
    }
    if (miniViewer) {
      miniViewer.destroy();
      miniViewer = null;
    }
    lastViewerTargetKey = null;
  }

  // Hook modal close so we always tear down the WebGL context
  if (modalEl) {
    const observer = new MutationObserver(() => {
      if (!modalEl.classList.contains('on')) destroyMiniViewer();
    });
    observer.observe(modalEl, { attributes: true, attributeFilter: ['class'] });
  }

  function buildMiniViewer3D(parentEl, targetKey, highlightPartIds, highlightHypIds, extraOpts = {}) {
    // Reuse the existing viewer if we're rebuilding for the same target.
    // This preserves the camera rotation/zoom across in-place updates
    // (e.g. toggling a connection, editing dimensions).
    //
    // We deliberately do NOT require parentEl.contains(miniViewer.containerEl)
    // here. The open() flow wipes bodyEl.innerHTML before calling us, which
    // detaches the viewer's container but does not destroy it. Re-attaching
    // the detached container is exactly what we want — the WebGL context,
    // camera state, and meshes are all preserved through the detach.
    if (miniViewer && lastViewerTargetKey === targetKey) {
      miniViewer.updateHighlights({
        highlightPartIds,
        connectedPartIds: extraOpts.connectedPartIds || []
      });
      // The body was wiped before we got here — re-attach the existing
      // viewer container as the first child of the new body.
      parentEl.insertBefore(miniViewer.containerEl, parentEl.firstChild);
      // Reinstall the (potentially updated) click handler
      if (typeof extraOpts.onPartClick === 'function') {
        miniViewer.setOnPartClick(extraOpts.onPartClick);
      }
      return;
    }

    destroyMiniViewer();
    const wrap = el('div', 'detail-3d-mini');
    parentEl.appendChild(wrap);
    lastViewerTargetKey = targetKey;
    // Defer to next frame so the wrap has its size before WebGL initializes.
    // Track the rAF handle so a fast close() can cancel pending creation —
    // otherwise we leak a brand-new WebGL context the closer can't reach.
    if (pendingViewerRaf) cancelAnimationFrame(pendingViewerRaf);
    pendingViewerRaf = requestAnimationFrame(() => {
      pendingViewerRaf = null;
      // Modal may have closed between insert and rAF firing. Bail out
      // rather than spinning up a WebGL context that nobody can dispose.
      if (!modalEl.classList.contains('on')) return;
      if (!wrap.isConnected) return;
      miniViewer = createMiniViewer3D(wrap);
      miniViewer.containerEl = wrap;
      miniViewer.render(getWorkspace(), {
        highlightPartIds,
        highlightHypIds,
        ...extraOpts
      });
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Tracks which target the mini-viewer was last initialized for. If a
  // subsequent open() call requests the same target (e.g. because the
  // workspace updated and renderAll() asked us to refresh the modal),
  // we keep the existing viewer instance to preserve camera state. We
  // still call updateHighlights() so colour state stays in sync.
  let lastViewerTargetKey = null;

  function open(target, opts = {}) {
    if (!target) return;
    const ws = getWorkspace();
    if (target.type === 'part') openPart(target.id, ws, opts);
    else if (target.type === 'hypothesis') openHypothesis(target.id, ws, opts);
    else if (target.type === 'step') openStep(target.id, ws, opts);
  }

  function showModal() {
    modalEl.classList.add('on');
  }
  function hideModal() {
    modalEl.classList.remove('on');
    revokePhotoUrls();
  }

  // ---------------------------------------------------------------- parts
  function openPart(id, ws) {
    const p = (ws.instance?.parts || []).find(x => x.id === id);
    if (!p) return;
    titleEl.textContent = `Part: ${p.id}`;
    bodyEl.innerHTML = '';

    // Mini 3D-Preview with click-to-toggle for connections.
    //   • the current part itself: red
    //   • parts in `connections`:   blue
    //   • everything else:          dim grey
    // Clicking a non-current part toggles connection symmetrically.
    const relatedHypIds = (ws.hypotheses || []).filter(h => h.partRef === id).map(h => h.id);
    const currentConnections = Array.isArray(p.connections) ? p.connections : [];
    buildMiniViewer3D(bodyEl, `part:${id}`, [id], relatedHypIds, {
      connectedPartIds: currentConnections,
      onPartClick: (clickedPartId) => toggleConnection(id, clickedPartId)
    });

    // Small hint banner under the viewer
    const hint = el('div', 'detail-3d-hint');
    hint.innerHTML = `<span class="hint-swatch hint-swatch-red"></span> this part &nbsp;&nbsp; <span class="hint-swatch hint-swatch-blue"></span> connected &nbsp;&nbsp; <span class="hint-dim">click any part to toggle a connection</span>`;
    bodyEl.appendChild(hint);

    const form = el('div', 'detail-form');
    form.appendChild(field('Label', input(p.label || '', v => patchPart(id, { label: v }))));
    form.appendChild(field('Material', input(p.material || '', v => patchPart(id, { material: v }))));
    form.appendChild(field('Status', selectInput(PART_STATUS, p.status || 'intact', v => patchPart(id, { status: v }))));

    const d = p.dimensions || {};
    const dimsRow = el('div', 'detail-form-row');
    dimsRow.appendChild(field('Width (m)', numInput(d.width, v => patchPart(id, { dimensions: { ...d, width: v } }))));
    dimsRow.appendChild(field('Height (m)', numInput(d.height, v => patchPart(id, { dimensions: { ...d, height: v } }))));
    dimsRow.appendChild(field('Depth (m)', numInput(d.depth, v => patchPart(id, { dimensions: { ...d, depth: v } }))));
    form.appendChild(dimsRow);

    form.appendChild(field('Connections (comma-separated)',
      input((p.connections || []).join(', '), v => patchPart(id, { connections: v.split(',').map(s => s.trim()).filter(Boolean) }))));
    form.appendChild(field('Notes', textarea(p.notes || '', v => patchPart(id, { notes: v }))));

    bodyEl.appendChild(form);

    // Related hypotheses, quick navigation
    const hyps = (ws.hypotheses || []).filter(x => x.partRef === id);
    if (hyps.length) {
      const list = el('div', 'detail-section');
      list.appendChild(el('div', 'detail-section-label', 'Conditions on this part'));
      hyps.forEach(h => {
        const row = el('div', 'detail-link-row');
        row.textContent = `${h.type} (${h.status})`;
        row.onclick = () => openHypothesis(h.id, getWorkspace());
        list.appendChild(row);
      });
      bodyEl.appendChild(list);
    }

    // Photos attached to this part (directly or via a hypothesis on it)
    const photos = (ws.evidence || []).filter(e => {
      if (e.kind !== 'photo') return false;
      if (e.attachedTo?.type === 'part' && e.attachedTo.id === id) return true;
      if (e.attachedTo?.type === 'hypothesis') {
        const h = (ws.hypotheses || []).find(x => x.id === e.attachedTo.id);
        if (h?.partRef === id) return true;
      }
      return false;
    });
    appendPhotoSection(bodyEl, photos, { type: 'part', id });

    showModal();
  }

  function patchPart(id, patch) {
    const ws = getWorkspace();
    const existing = (ws.instance?.parts || []).find(x => x.id === id);
    if (!existing) return;
    dispatch({ type: 'upsert-part', payload: { part: { ...existing, ...patch } } });
  }

  /**
   * Symmetric connection toggle.
   * If A is editing and the user clicks B, the connection is added or
   * removed on BOTH sides. Connections are physical and should always be
   * bidirectional. Empty arrays are normalized.
   *
   * After the dispatch the detail editor's caller re-renders the modal
   * (which rebuilds the mini-viewer) to reflect the new state.
   */
  function toggleConnection(currentPartId, otherPartId) {
    if (!otherPartId || otherPartId === currentPartId) return;
    const ws = getWorkspace();
    const current = (ws.instance?.parts || []).find(p => p.id === currentPartId);
    const other = (ws.instance?.parts || []).find(p => p.id === otherPartId);
    if (!current || !other) return;

    const currentConns = Array.isArray(current.connections) ? [...current.connections] : [];
    const otherConns = Array.isArray(other.connections) ? [...other.connections] : [];

    const wasConnected = currentConns.includes(otherPartId);

    let newCurrentConns;
    let newOtherConns;
    if (wasConnected) {
      newCurrentConns = currentConns.filter(x => x !== otherPartId);
      newOtherConns = otherConns.filter(x => x !== currentPartId);
    } else {
      newCurrentConns = [...currentConns, otherPartId];
      newOtherConns = otherConns.includes(currentPartId) ? otherConns : [...otherConns, currentPartId];
    }

    // Dispatch a batch of two upserts so undo/redo treats it as one step
    dispatch({
      type: 'batch',
      payload: {
        label: wasConnected
          ? `disconnect ${currentPartId} ↔ ${otherPartId}`
          : `connect ${currentPartId} ↔ ${otherPartId}`,
        commands: [
          { type: 'upsert-part', payload: { part: { ...current, connections: newCurrentConns } } },
          { type: 'upsert-part', payload: { part: { ...other, connections: newOtherConns } } }
        ]
      }
    });
  }

  // -------------------------------------------------------- hypotheses
  function openHypothesis(id, ws) {
    const h = (ws.hypotheses || []).find(x => x.id === id);
    if (!h) return;
    titleEl.textContent = `Condition: ${h.type || h.id}`;
    bodyEl.innerHTML = '';

    // Mini 3D-Preview: highlight the affected part + this condition's marker
    buildMiniViewer3D(bodyEl, `hyp:${id}`, h.partRef ? [h.partRef] : [], [id]);

    const form = el('div', 'detail-form');
    form.appendChild(field('Type', input(h.type || '', v => patchHypothesis(id, { type: v }))));
    form.appendChild(field('Description', textarea(h.description || '', v => patchHypothesis(id, { description: v }))));

    const meta = el('div', 'detail-form-row');
    meta.appendChild(field('Status', selectInput(HYPOTHESIS_STATUS, h.status || 'suspected', v => patchHypothesis(id, { status: v }))));
    meta.appendChild(field('Confidence',
      rangeInput(h.confidence ?? 0.5, v => patchHypothesis(id, { confidence: v }))));
    form.appendChild(meta);

    form.appendChild(field('Part ref',
      partRefSelect(h.partRef || '', ws, v => patchHypothesis(id, { partRef: v || null }))));

    // Coordinates editor
    const c = h.coordinates || { x: 0, y: 0, z: 0 };
    const coordRow = el('div', 'detail-form-row');
    coordRow.appendChild(field('X', numInput(c.x, v => patchHypothesis(id, { coordinates: { ...c, x: v } }))));
    coordRow.appendChild(field('Y', numInput(c.y, v => patchHypothesis(id, { coordinates: { ...c, y: v } }))));
    coordRow.appendChild(field('Z', numInput(c.z, v => patchHypothesis(id, { coordinates: { ...c, z: v } }))));
    form.appendChild(coordRow);

    bodyEl.appendChild(form);

    // Photo gallery for this hypothesis (direct attachments only)
    const photos = (ws.evidence || []).filter(e =>
      e.kind === 'photo' && e.attachedTo?.type === 'hypothesis' && e.attachedTo.id === id);
    appendPhotoSection(bodyEl, photos, { type: 'hypothesis', id });

    // Delete button
    const actions = el('div', 'detail-actions');
    const del = el('button', 'detail-delete', 'Delete condition');
    del.onclick = () => {
      if (!confirm(`Delete condition "${h.type}"? This can be undone with Ctrl+Z.`)) return;
      dispatch({ type: 'remove-hypothesis', payload: { hypothesisId: id } });
      hideModal();
    };
    actions.appendChild(del);
    bodyEl.appendChild(actions);

    showModal();
  }

  function patchHypothesis(id, patch) {
    dispatch({ type: 'update-hypothesis', payload: { hypothesisId: id, patch } });
  }

  function partRefSelect(value, ws, onChange) {
    const sel = el('select', 'detail-input');
    sel.innerHTML = '<option value="">— none —</option>';
    (ws.instance?.parts || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.id;
      if (p.id === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => onChange(sel.value);
    return sel;
  }

  // -------------------------------------------------------- steps
  function openStep(id, ws) {
    const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
    const s = plan?.steps?.find(x => x.id === id);
    if (!s) return;
    titleEl.textContent = `Step: ${s.title || s.id}`;
    bodyEl.innerHTML = '';

    // If this step is currently being enriched in Phase B, show a dezent
    // banner so the user knows the details below will fill in soon.
    const enrichingIds = window.__getEnrichingStepIds?.() || new Set();
    if (enrichingIds.has(id)) {
      const enr = el('div', 'enriching-banner');
      enr.innerHTML = `<span class="enriching-dot"></span> AI is enriching this step with tools, time estimate, rationale… The fields below will update in a moment.`;
      bodyEl.appendChild(enr);
    }

    // Mini 3D-Preview: highlight affected parts + condition markers for
    // conditions this step addresses. Gives spatial context at a glance.
    buildMiniViewer3D(bodyEl, `step:${id}`, s.affectedPartRefs || [], s.addressesHypothesisRefs || []);

    // If this step is inside a mutex group (i.e. one of several alternatives),
    // show a banner at the top with a button to commit to this branch.
    const mutexGroup = (plan.mutexGroups || []).find(g => (g.stepIds || []).includes(id));
    if (mutexGroup) {
      const banner = buildMutexBanner(plan, mutexGroup, s);
      bodyEl.appendChild(banner);
    }

    const form = el('div', 'detail-form');
    form.appendChild(field('Title', input(s.title || '', v => patchStep(plan.id, id, { title: v }))));
    form.appendChild(field('Description', textarea(s.description || '', v => patchStep(plan.id, id, { description: v }))));
    form.appendChild(field('Expected outcome', textarea(s.expectedOutcome || '', v => patchStep(plan.id, id, { expectedOutcome: v }))));

    const row = el('div', 'detail-form-row');
    row.appendChild(field('Status', selectInput(STEP_STATUS, s.status || 'pending', v => patchStep(plan.id, id, { status: v }))));
    row.appendChild(field('Est. min', numInput(s.estimatedMinutes, v => patchStep(plan.id, id, { estimatedMinutes: v }))));
    row.appendChild(field('Confidence', rangeInput(s.confidence ?? 0.7, v => patchStep(plan.id, id, { confidence: v }))));
    form.appendChild(row);

    form.appendChild(field('Tools (comma-separated)',
      input((s.toolsRequired || []).join(', '), v => patchStep(plan.id, id, { toolsRequired: v.split(',').map(t => t.trim()).filter(Boolean) }))));
    form.appendChild(field('Materials (comma-separated)',
      input((s.materialsRequired || []).join(', '), v => patchStep(plan.id, id, { materialsRequired: v.split(',').map(t => t.trim()).filter(Boolean) }))));

    if (s.justification?.rationale) {
      const j = el('div', 'detail-section');
      j.appendChild(el('div', 'detail-section-label', 'AI rationale'));
      j.appendChild(el('div', 'detail-rationale', s.justification.rationale));
      form.appendChild(j);
    }

    bodyEl.appendChild(form);
    showModal();
  }

  function buildMutexBanner(plan, group, currentStep) {
    const banner = el('div', 'mutex-banner');
    const isSelected = group.selectedStepId === currentStep.id;
    const noneSelected = !group.selectedStepId;
    const otherSelected = group.selectedStepId && !isSelected;

    const label = el('div', 'mutex-banner-label');
    label.textContent = group.label || 'Choose one alternative';
    banner.appendChild(label);

    // Status indicator
    const status = el('div', 'mutex-banner-status');
    if (isSelected) {
      status.textContent = '✓ This branch is chosen. The other alternatives will be skipped.';
      status.classList.add('chosen');
    } else if (otherSelected) {
      const other = plan.steps.find(st => st.id === group.selectedStepId);
      status.textContent = `Currently chosen: ${other?.title || group.selectedStepId}. This branch will be skipped unless you switch.`;
      status.classList.add('other');
    } else {
      status.textContent = `One of ${group.stepIds.length} alternatives — pick one before executing.`;
    }
    banner.appendChild(status);

    // Action row
    const actions = el('div', 'mutex-banner-actions');
    if (isSelected) {
      const undo = el('button', 'mutex-banner-btn outline', '↶ Unchoose');
      undo.onclick = () => {
        dispatch({ type: 'select-mutex-branch', payload: { planId: plan.id, groupId: group.id, stepId: null } });
      };
      actions.appendChild(undo);
    } else {
      const pick = el('button', 'mutex-banner-btn primary', '✓ Choose this branch');
      pick.onclick = () => {
        dispatch({ type: 'select-mutex-branch', payload: { planId: plan.id, groupId: group.id, stepId: currentStep.id } });
      };
      actions.appendChild(pick);
    }
    banner.appendChild(actions);

    // Quick navigation to siblings
    const siblings = group.stepIds.filter(sid => sid !== currentStep.id);
    if (siblings.length) {
      const sibLabel = el('div', 'mutex-banner-siblings-label', 'Other alternatives:');
      banner.appendChild(sibLabel);
      const sibList = el('div', 'mutex-banner-siblings');
      siblings.forEach(sid => {
        const sib = plan.steps.find(st => st.id === sid);
        if (!sib) return;
        const row = el('div', 'mutex-banner-sibling');
        const isOtherChosen = group.selectedStepId === sid;
        row.textContent = (isOtherChosen ? '✓ ' : '') + (sib.title || sid);
        row.onclick = () => openStep(sid, getWorkspace());
        sibList.appendChild(row);
      });
      banner.appendChild(sibList);
    }

    return banner;
  }

  function patchStep(planId, stepId, patch) {
    const ws = getWorkspace();
    const plan = (ws.plans || []).find(p => p.id === planId);
    const step = plan?.steps?.find(x => x.id === stepId);
    if (!step) return;
    dispatch({ type: 'upsert-step', payload: { planId, step: { ...step, ...patch } } });
  }

  // -------------------------------------------------------- photo gallery
  const objectUrls = [];

  /**
   * Always-rendered photo section for an entity (part or hypothesis):
   *   - section label with count
   *   - thumbnail grid (if any photos)
   *   - "+ Add photo" button at the bottom
   * Photos load asynchronously; the section is appended synchronously
   * so the button is immediately visible.
   */
  function appendPhotoSection(parentEl, photos, attachTarget) {
    const wrap = el('div', 'detail-section');
    const labelText = photos.length ? `Photos (${photos.length})` : 'Photos';
    wrap.appendChild(el('div', 'detail-section-label', labelText));

    const grid = el('div', 'detail-photo-grid');
    if (photos.length) {
      // Render placeholders synchronously, fill them in async
      photos.forEach(ev => {
        const slot = el('div', 'detail-photo-slot');
        slot.innerHTML = '<div class="detail-photo-loading">…</div>';
        grid.appendChild(slot);
        getPhotoBlob(ev.id).then(photo => {
          if (!photo) {
            slot.innerHTML = '<div class="detail-photo-missing" title="Photo not on this device">📷 missing</div>';
            return;
          }
          const url = URL.createObjectURL(photo.blob);
          objectUrls.push(url);
          slot.innerHTML = `<img src="${url}" alt="${escapeHtml(ev.fileName || ev.id)}">`;
          slot.onclick = () => openLightbox(url, ev.fileName);
        }).catch(() => {
          slot.innerHTML = '<div class="detail-photo-missing">⚠️ failed</div>';
        });
      });
    } else {
      const empty = el('div', 'detail-photo-empty');
      empty.textContent = 'No photos yet.';
      grid.appendChild(empty);
    }
    wrap.appendChild(grid);

    // Add-photo button (only if a handler was provided)
    if (onAttachPhoto) {
      const addBtn = el('button', 'detail-photo-add-btn', '📷  Add photo');
      addBtn.onclick = () => onAttachPhoto(attachTarget);
      wrap.appendChild(addBtn);
    }

    parentEl.appendChild(wrap);
    return wrap;
  }

  async function buildPhotoGallery(photos) {
    // Legacy wrapper kept for any callers that still use it.
    const wrap = el('div', 'detail-section');
    wrap.appendChild(el('div', 'detail-section-label', `Photos (${photos.length})`));
    const grid = el('div', 'detail-photo-grid');
    wrap.appendChild(grid);

    for (const ev of photos) {
      const slot = el('div', 'detail-photo-slot');
      slot.innerHTML = '<div class="detail-photo-loading">…</div>';
      grid.appendChild(slot);
      try {
        const photo = await getPhotoBlob(ev.id);
        if (!photo) {
          slot.innerHTML = '<div class="detail-photo-missing" title="Photo not on this device">📷 missing</div>';
          continue;
        }
        const url = URL.createObjectURL(photo.blob);
        objectUrls.push(url);
        slot.innerHTML = `<img src="${url}" alt="${escapeHtml(ev.fileName || ev.id)}">`;
        slot.onclick = () => openLightbox(url, ev.fileName);
      } catch (err) {
        slot.innerHTML = '<div class="detail-photo-missing">⚠️ failed</div>';
      }
    }
    return wrap;
  }

  function revokePhotoUrls() {
    while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
  }

  function openLightbox(url, name) {
    const overlay = el('div', 'photo-lightbox');
    overlay.innerHTML = `<img src="${url}" alt=""><div class="photo-lightbox-name">${escapeHtml(name || '')}</div>`;
    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);
  }

  // -------------------------------------------------------- form helpers

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function field(labelText, inputEl) {
    const wrap = el('label', 'detail-field');
    wrap.appendChild(el('span', 'detail-field-label', labelText));
    wrap.appendChild(inputEl);
    return wrap;
  }

  function input(value, onChange) {
    const i = el('input', 'detail-input');
    i.type = 'text';
    i.value = value;
    i.onchange = () => onChange(i.value);
    return i;
  }

  function textarea(value, onChange) {
    const t = el('textarea', 'detail-input');
    t.value = value;
    t.rows = Math.max(2, Math.min(6, Math.ceil((value || '').length / 60) + 1));
    t.onchange = () => onChange(t.value);
    return t;
  }

  function numInput(value, onChange) {
    const i = el('input', 'detail-input');
    i.type = 'number';
    i.step = 'any';
    i.value = value ?? '';
    i.onchange = () => {
      const v = parseFloat(i.value);
      onChange(Number.isFinite(v) ? v : null);
    };
    return i;
  }

  function selectInput(options, value, onChange) {
    const sel = el('select', 'detail-input');
    options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (opt === value) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => onChange(sel.value);
    return sel;
  }

  function rangeInput(value, onChange) {
    const wrap = el('div', 'detail-range-wrap');
    const r = el('input', 'detail-range');
    r.type = 'range';
    r.min = '0';
    r.max = '1';
    r.step = '0.05';
    r.value = value;
    const display = el('span', 'detail-range-value', `${Math.round(value * 100)}%`);
    r.oninput = () => {
      display.textContent = `${Math.round(Number(r.value) * 100)}%`;
    };
    r.onchange = () => onChange(Number(r.value));
    wrap.appendChild(r);
    wrap.appendChild(display);
    return wrap;
  }

  return { open, close: hideModal };
}
