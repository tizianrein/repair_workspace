/**
 * Propose review modal.
 *
 * Shows the AI's proposal: a summary, and (collapsible) the list of commands
 * it wants to apply. The user can Accept all, Reject, or expand and check
 * individual commands for partial acceptance.
 *
 * Returns a Promise that resolves with the accepted commands array, or null
 * if rejected/closed.
 */

export function showProposeReview({ summary, commands }) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal on propose-review-modal';
    modal.innerHTML = `
      <div class="modal-card wide">
        <div class="modal-head">
          <h3>The AI proposes</h3>
          <button class="icon-btn" data-act="close">✕</button>
        </div>
        <div class="modal-body">
          <div class="propose-summary"></div>
          <button class="propose-details-toggle" data-act="toggle">
            <span class="chev">▾</span> See the ${commands.length} change${commands.length === 1 ? '' : 's'} in detail
          </button>
          <div class="propose-details" hidden>
            <div class="propose-bulk-actions">
              <button data-act="all">Check all</button>
              <button data-act="none">Uncheck all</button>
            </div>
            <ul class="propose-cmd-list"></ul>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" data-act="reject">Reject</button>
          <div class="spacer"></div>
          <button class="btn" data-act="accept">Apply selected</button>
        </div>
      </div>
    `;

    modal.querySelector('.propose-summary').textContent = summary || 'The AI proposed changes (no summary given).';

    const cmdList = modal.querySelector('.propose-cmd-list');
    commands.forEach((cmd, i) => {
      const li = document.createElement('li');
      li.className = 'propose-cmd';
      const summary = summarizeCommand(cmd);
      li.innerHTML = `
        <label>
          <input type="checkbox" data-idx="${i}" checked>
          <span class="propose-cmd-type">${escapeHtml(cmd.type)}</span>
          <span class="propose-cmd-summary">${escapeHtml(summary)}</span>
        </label>
      `;
      cmdList.appendChild(li);
    });

    const details = modal.querySelector('.propose-details');
    const chev = modal.querySelector('.propose-details-toggle .chev');

    modal.addEventListener('click', e => {
      const act = e.target.dataset.act || e.target.closest('[data-act]')?.dataset.act;
      if (act === 'toggle') {
        const hidden = details.hidden;
        details.hidden = !hidden;
        chev.style.transform = hidden ? 'rotate(0deg)' : 'rotate(-90deg)';
      } else if (act === 'all') {
        cmdList.querySelectorAll('input').forEach(c => { c.checked = true; });
      } else if (act === 'none') {
        cmdList.querySelectorAll('input').forEach(c => { c.checked = false; });
      } else if (act === 'reject' || act === 'close') {
        modal.remove();
        resolve(null);
      } else if (act === 'accept') {
        const checked = Array.from(cmdList.querySelectorAll('input'))
          .filter(c => c.checked)
          .map(c => commands[Number(c.dataset.idx)]);
        modal.remove();
        resolve(checked);
      }
    });

    document.body.appendChild(modal);
  });
}

function summarizeCommand(cmd) {
  const p = cmd.payload || {};
  switch (cmd.type) {
    case 'set-object-name': return `Rename object to "${p.name}"`;
    case 'replace-assembly': return `Replace assembly: ${p.objectName || '?'} (${p.parts?.length || 0} parts)`;
    case 'upsert-part': return `Add or update part "${p.part?.id}" (${p.part?.status || '?'})`;
    case 'remove-part': return `Remove part "${p.partId}"`;
    case 'add-condition': {
      const h = p.condition || {};
      return `Add ${h.status || 'suspected'} condition: ${h.type || '?'} on ${h.partRef || '?'}`;
    }
    case 'update-condition': return `Update condition ${p.conditionId}`;
    case 'remove-condition': return `Remove condition ${p.conditionId}`;
    case 'confirm-condition': return `Confirm condition ${p.conditionId}`;
    case 'refute-condition': return `Refute condition ${p.conditionId}`;
    case 'set-intent': return `Update repair intent${p.intent?.summary ? ` — "${truncate(p.intent.summary, 60)}"` : ''}`;
    case 'set-constraints': return `Update constraints`;
    case 'add-plan': {
      const pl = p.plan || {};
      return `Add plan "${pl.label || 'unnamed'}" with ${pl.steps?.length || 0} steps`;
    }
    case 'remove-plan': return `Remove plan ${p.planId}`;
    case 'set-current-plan': return `Switch to plan ${p.planId}`;
    case 'set-plan-status': return `Mark plan ${p.planId} as ${p.status}`;
    case 'upsert-step': return `Add or update step "${p.step?.title || p.step?.id}"`;
    case 'remove-step': return `Remove step ${p.stepId}`;
    case 'add-edge': return `Link: ${p.source} → ${p.target}`;
    case 'remove-edge': return `Unlink edge ${p.edgeId}`;
    case 'add-mutex-group': return `Group alternatives: ${(p.stepIds || []).join(' | ')}`;
    case 'select-mutex-branch': return `Pick alternative: ${p.stepId}`;
    case 'add-evidence': return `Attach ${p.evidence?.kind || 'evidence'}`;
    case 'log-execution': return `Log execution of step ${p.entry?.stepRef}`;
    default: return JSON.stringify(p).slice(0, 80);
  }
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
