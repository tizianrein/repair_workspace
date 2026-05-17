/**
 * Parts & conditions list.
 *
 * Renders into the right drawer. Filter dropdown swaps between all / parts /
 * conditions / specific statuses. Search is substring across id, type,
 * material, description. Tap a card → onDetail callback.
 */

export function createEntityList(container, searchInput, filterSelect, countEl, footerEl, { onDetail }) {
  let workspace = null;
  let selection = { partId: null, conditionId: null };

  function render(ws) { workspace = ws; refresh(); }
  function setSelection(sel) { selection = { ...selection, ...sel }; refresh(); }

  function refresh() {
    if (!workspace) return;
    const q = (searchInput.value || '').toLowerCase().trim();
    const filter = filterSelect.value;
    const parts = workspace.instance?.parts || [];
    const conditions = workspace.conditions || [];

    const showParts = ['all', 'parts', 'defective', 'missing'].includes(filter);
    const showHyps = ['all', 'conditions', 'suspected', 'confirmed'].includes(filter);

    const matchedParts = !showParts ? [] : parts.filter(p => {
      if (filter === 'defective' && p.status !== 'defective') return false;
      if (filter === 'missing' && p.status !== 'missing') return false;
      if (!q) return true;
      return p.id.toLowerCase().includes(q) || (p.material || '').toLowerCase().includes(q) || (p.status || '').toLowerCase().includes(q);
    });
    const matchedHyps = !showHyps ? [] : conditions.filter(h => {
      if (filter === 'suspected' && h.status !== 'suspected') return false;
      if (filter === 'confirmed' && h.status !== 'confirmed') return false;
      if (!q) return true;
      return h.id.toLowerCase().includes(q)
        || (h.type || '').toLowerCase().includes(q)
        || (h.description || '').toLowerCase().includes(q)
        || (h.partRef || '').toLowerCase().includes(q);
    });

    container.innerHTML = '';

    if (!matchedParts.length && !matchedHyps.length) {
      container.innerHTML = `<div class="entity-empty">${workspace.instance?.parts?.length ? 'No matches.' : 'Load an example or workspace JSON.'}</div>`;
    } else {
      const hypsByPart = new Map();
      conditions.forEach(h => {
        if (!hypsByPart.has(h.partRef)) hypsByPart.set(h.partRef, []);
        hypsByPart.get(h.partRef).push(h);
      });

      matchedParts.forEach(p => {
        const card = document.createElement('div');
        card.className = 'entity-card' + (p.id === selection.partId ? ' selected' : '');
        const dmgs = hypsByPart.get(p.id) || [];
        const meta = dmgs.length
          ? `${dmgs.length} condition${dmgs.length > 1 ? 's' : ''} · ${dmgs.map(d => d.type).join(', ')}`
          : (p.material || '');
        card.innerHTML = `
          <div class="ec-row">
            <span class="ec-id">${escapeHtml(p.id)}</span>
            <span class="ec-status ${p.status || 'intact'}">${(p.status || 'intact').toUpperCase()}</span>
          </div>
          ${meta ? `<div class="ec-meta">${escapeHtml(meta)}</div>` : ''}
        `;
        card.onclick = () => onDetail?.({ type: 'part', id: p.id });
        container.appendChild(card);
      });

      matchedHyps.forEach(h => {
        const card = document.createElement('div');
        card.className = 'entity-card dmg' + (h.id === selection.conditionId ? ' selected' : '');
        const statusBadge = `<span class="ec-status ${h.status}">${h.status.toUpperCase()}</span>`;
        card.innerHTML = `
          <div class="ec-row">
            <span class="ec-id"><span class="ec-type-pill">${escapeHtml(h.type || 'condition')}</span>${escapeHtml(h.id)}</span>
            ${statusBadge}
          </div>
          <div class="ec-meta">on ${escapeHtml(h.partRef || '—')}${h.description ? ' · ' + escapeHtml(h.description.slice(0, 80)) : ''}</div>
        `;
        card.onclick = () => onDetail?.({ type: 'condition', id: h.id });
        container.appendChild(card);
      });
    }

    const totalParts = parts.length;
    const totalHyps = conditions.length;
    countEl.textContent = totalHyps;
    footerEl.textContent = `${totalParts} parts · ${totalHyps} condition${totalHyps === 1 ? '' : 's'} · ${conditions.filter(h => h.status === 'suspected').length} suspected`;
  }

  searchInput.addEventListener('input', refresh);
  filterSelect.addEventListener('change', refresh);

  return { render, setSelection };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
