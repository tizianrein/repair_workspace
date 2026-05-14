/**
 * Execution log entry form.
 *
 * Shown when the user marks a step as completed. Captures:
 *   - Actual duration
 *   - Outcome (as-planned / deviated / blocked)
 *   - Deviation description if not as-planned
 *   - Rationale for the deviation
 *
 * The execution entry is added via a batch command alongside marking the step
 * complete, so undo undoes both together.
 */

export function showExecutionEntry(step) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal on';
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h3>Mark complete</h3>
          <button class="icon-btn" data-act="close">✕</button>
        </div>
        <div class="modal-body">
          <div class="exec-step-title">${escapeHtml(step.title || step.id)}</div>
          <div class="field-row">
            <div class="field">
              <label>Actual time (min)</label>
              <input type="number" id="exec-mins" min="0" step="1" value="${step.estimatedMinutes || ''}" placeholder="${step.estimatedMinutes ? `estimated ${step.estimatedMinutes}` : ''}">
            </div>
            <div class="field">
              <label>Outcome</label>
              <select id="exec-outcome">
                <option value="as-planned">As planned</option>
                <option value="deviated">Deviated</option>
                <option value="blocked">Blocked (couldn't finish)</option>
              </select>
            </div>
          </div>
          <div class="field" id="exec-deviation-wrap" hidden>
            <label>What did you do instead?</label>
            <textarea id="exec-deviation" rows="2" placeholder="e.g. Scraped instead of sanding — paint was thicker than expected."></textarea>
          </div>
          <div class="field" id="exec-rationale-wrap" hidden>
            <label>Why? (optional but useful for future repairs)</label>
            <textarea id="exec-rationale" rows="2"></textarea>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" data-act="cancel">Cancel</button>
          <div class="spacer"></div>
          <button class="btn" data-act="save">Save and mark done</button>
        </div>
      </div>
    `;

    const outcomeSel = modal.querySelector('#exec-outcome');
    const devWrap = modal.querySelector('#exec-deviation-wrap');
    const ratWrap = modal.querySelector('#exec-rationale-wrap');
    outcomeSel.addEventListener('change', () => {
      const v = outcomeSel.value;
      devWrap.hidden = v === 'as-planned';
      ratWrap.hidden = v === 'as-planned';
    });

    modal.addEventListener('click', e => {
      const act = e.target.dataset.act || e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel' || act === 'close') {
        modal.remove();
        resolve(null);
      } else if (act === 'save') {
        const entry = {
          stepRef: step.id,
          actualDurationMinutes: Number(modal.querySelector('#exec-mins').value) || null,
          outcome: outcomeSel.value,
          deviation: modal.querySelector('#exec-deviation').value.trim() || '',
          rationale: modal.querySelector('#exec-rationale').value.trim() || '',
          completedAt: new Date().toISOString()
        };
        modal.remove();
        resolve(entry);
      }
    });

    document.body.appendChild(modal);
    setTimeout(() => modal.querySelector('#exec-mins')?.focus(), 50);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
