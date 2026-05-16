/**
 * Justification panel.
 *
 * Shown when a step is selected in the action graph. Displays the trace from
 * step → driving hypotheses (clickable), driving intent axes (with their
 * current values), driving constraints, and the model's rationale.
 *
 * Read-only. To change a step, the user uses the detail modal or the chat.
 */

export function createJustificationPanel(container, { getWorkspace, onJumpToHypothesis }) {
  function clear() { container.innerHTML = ''; container.classList.remove('on'); }

  function show(stepId) {
    const ws = getWorkspace();
    const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
    const step = plan?.steps?.find(s => s.id === stepId);
    if (!step) { clear(); return; }

    const j = step.justification || {};
    // In v2.1 intent is per-strategy; pull it from the current plan
    // (which is also the plan we just looked the step up in).
    const intentAxes = plan?.intent?.axes || [];
    const intentByAxis = new Map(intentAxes.map(a => [a.id, a]));
    const hypById = new Map((ws.hypotheses || []).map(h => [h.id, h]));

    const drivingAxes = (j.drivingIntentAxes || []).map(id => intentByAxis.get(id)).filter(Boolean);
    const drivingHyps = (j.drivingHypotheses || []).map(id => hypById.get(id)).filter(Boolean);
    const drivingConstraints = j.drivingConstraints || [];

    const confidence = Math.round((step.confidence ?? 0) * 100);
    const confClass = confidence >= 75 ? 'high' : confidence >= 50 ? 'med' : 'low';

    container.innerHTML = `
      <div class="jp-head">
        <span class="jp-label">Why this step?</span>
        <button class="jp-close">✕</button>
      </div>
      <div class="jp-body">
        <div class="jp-step-title">${escapeHtml(step.title || step.id)}</div>
        <div class="jp-conf jp-conf-${confClass}">
          <span>Model confidence</span>
          <strong>${confidence}%</strong>
        </div>
        ${j.rationale ? `<div class="jp-rationale">${escapeHtml(j.rationale)}</div>` : '<div class="jp-empty">No rationale recorded.</div>'}
        ${drivingHyps.length ? `
          <div class="jp-section">
            <div class="jp-section-label">Addressing</div>
            <ul class="jp-list">
              ${drivingHyps.map(h => `
                <li class="jp-clickable" data-hyp="${h.id}">
                  <span class="jp-hyp-type">${escapeHtml(h.type || '?')}</span>
                  <span class="jp-hyp-status ${h.status}">${h.status}</span>
                  <span class="jp-hyp-part">on ${escapeHtml(h.partRef || '—')}</span>
                </li>
              `).join('')}
            </ul>
          </div>` : ''}
        ${drivingAxes.length ? `
          <div class="jp-section">
            <div class="jp-section-label">Driven by intent</div>
            <ul class="jp-list">
              ${drivingAxes.map(a => `
                <li>
                  <span class="jp-axis-label">${escapeHtml(a.label)}</span>
                  <span class="jp-axis-bar"><span style="width:${Math.round(a.value * 100)}%"></span></span>
                  <span class="jp-axis-value">${Math.round(a.value * 100)}%</span>
                </li>
              `).join('')}
            </ul>
          </div>` : ''}
        ${drivingConstraints.length ? `
          <div class="jp-section">
            <div class="jp-section-label">Constraints in play</div>
            <ul class="jp-list">
              ${drivingConstraints.map(c => `<li>${escapeHtml(c)}</li>`).join('')}
            </ul>
          </div>` : ''}
      </div>
    `;
    container.classList.add('on');

    container.querySelector('.jp-close').onclick = clear;
    container.querySelectorAll('.jp-clickable').forEach(li => {
      li.onclick = () => onJumpToHypothesis?.(li.dataset.hyp);
    });
  }

  return { show, clear };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
