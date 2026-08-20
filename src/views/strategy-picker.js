/**
 * Strategy picker — choose which strategy to export.
 *
 * Export is per-strategy, not per-workspace. A workspace ZIP containing five
 * strategies is a blob nobody can act on; a single-strategy bundle is the unit
 * people actually exchange ("send me your splice approach and I'll load it
 * next to mine"), and the unit the research compares.
 *
 * Built imperatively rather than in index.html so the markup lives next to the
 * behaviour that owns it.
 */

export function showStrategyPicker(workspace, { authorName } = {}) {
  return new Promise(resolve => {
    const plans = workspace.plans || [];
    if (!plans.length) { resolve(null); return; }
    // Nothing to choose between — don't make someone confirm a single option.
    if (plans.length === 1) { resolve(plans[0].id); return; }

    const overlay = document.createElement('div');
    overlay.className = 'modal on strategy-picker-modal';

    const conditions = (workspace.conditions || []).length;
    const rows = [...plans].reverse().map(p => {
      const steps = (p.steps || []).length;
      const renders = (workspace.evidence || [])
        .filter(e => e.kind === 'rendering' && e.planRef === p.id).length;
      const when = p.updatedAt || p.createdAt;
      const meta = [
        `${steps} step${steps === 1 ? '' : 's'}`,
        `${conditions} condition${conditions === 1 ? '' : 's'}`,
        renders ? `${renders} image${renders === 1 ? '' : 's'}` : null,
        p.status,
      ].filter(Boolean).join(' · ');
      return `
        <button class="sp-row${p.id === workspace.currentPlanId ? ' current' : ''}"
                data-plan="${escapeAttr(p.id)}" type="button">
          <span class="sp-swatch" style="background:${escapeAttr(p.color || '#888')}"></span>
          <span class="sp-text">
            <span class="sp-label">${escapeHtml(p.label || 'Untitled strategy')}</span>
            <span class="sp-meta">${escapeHtml(meta)}${when ? ' · ' + new Date(when).toLocaleDateString() : ''}</span>
          </span>
          ${p.id === workspace.currentPlanId ? '<span class="sp-current">current</span>' : ''}
        </button>`;
    }).join('');

    overlay.innerHTML = `
      <div class="modal-card strategy-picker-card">
        <div class="modal-head">
          <h3>Export a strategy</h3>
          <button class="icon-btn" data-cancel title="Cancel">✕</button>
        </div>
        <div class="modal-body">
          <p class="sp-copy">One ZIP per strategy. The bundle carries the artefact, the
            conditions, this strategy's steps, its images and its conversation —
            enough to open on its own or load alongside someone else's.</p>
          <div class="sp-list">${rows}</div>
        </div>
      </div>`;

    function close(value) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }

    overlay.querySelectorAll('.sp-row').forEach(btn => {
      btn.onclick = () => close(btn.dataset.plan);
    });
    overlay.querySelector('[data-cancel]').onclick = () => close(null);
    overlay.onclick = e => { if (e.target === overlay) close(null); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('.sp-row')?.focus();
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
