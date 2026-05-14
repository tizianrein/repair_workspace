/**
 * Intent radar.
 *
 * Reads workspace.intent.axes. Drag anywhere on the canvas to set the nearest
 * axis to that radial distance (0..1). Below the canvas, renders an editable
 * list of axes with text labels + range sliders + a remove button.
 *
 * Pure-ish: emits changes via onChange(newIntent), doesn't mutate state.
 */

export function createRadar(canvas, listContainer, summaryTextarea, { onChange }) {
  let intent = null;
  let dragging = false;

  function render(workspace) {
    intent = JSON.parse(JSON.stringify(workspace.intent));
    summaryTextarea.value = intent.summary || '';
    renderCanvas();
    renderList();
  }

  function renderCanvas() {
    if (!intent) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Polygon takes ~28% of canvas; labels need room outside (offset 38px
    // + up to 130px wrap width / 2 on each side).
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.28;
    const axes = intent.axes;
    const n = Math.max(axes.length, 3);

    ctx.strokeStyle = '#d6d4cc';
    ctx.lineWidth = 1;
    for (let ring = 1; ring <= 5; ring++) {
      ctx.beginPath();
      axes.forEach((_, i) => {
        const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
        const px = cx + Math.cos(a) * r * (ring / 5);
        const py = cy + Math.sin(a) * r * (ring / 5);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
    }

    axes.forEach((axis, i) => {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.stroke();

      ctx.fillStyle = '#1a1a1a';
      ctx.font = '20px "JetBrains Mono", monospace';
      const lx = cx + Math.cos(a) * (r + 42);
      const ly = cy + Math.sin(a) * (r + 42);
      ctx.textAlign = lx > cx + 6 ? 'left' : lx < cx - 6 ? 'right' : 'center';
      ctx.textBaseline = ly > cy + 6 ? 'top' : ly < cy - 6 ? 'bottom' : 'middle';
      wrap(ctx, axis.label, lx, ly, 130, 22);
    });

    ctx.fillStyle = 'rgba(193,39,45,.18)';
    ctx.strokeStyle = '#c1272d';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    axes.forEach((axis, i) => {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
      const px = cx + Math.cos(a) * r * axis.value;
      const py = cy + Math.sin(a) * r * axis.value;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    axes.forEach((axis, i) => {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
      const px = cx + Math.cos(a) * r * axis.value;
      const py = cy + Math.sin(a) * r * axis.value;
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a1a';
      ctx.fill();
    });
  }

  function renderList() {
    listContainer.innerHTML = '';
    intent.axes.forEach((axis, idx) => {
      const row = document.createElement('div');
      row.className = 'axis-row';
      row.innerHTML = `
        <div>
          <input type="text" value="${escapeHtml(axis.label)}" data-kind="label" data-idx="${idx}">
          <input type="range" min="0" max="1" step="0.01" value="${axis.value}" data-kind="value" data-idx="${idx}">
        </div>
        <div class="axis-value" data-idx="${idx}">${Math.round(axis.value * 100)}%</div>
        <button class="mini-btn x" data-kind="remove" data-idx="${idx}">×</button>
      `;
      listContainer.appendChild(row);
    });
    // For sliders and text inputs, "input" fires continuously while the user
    // is interacting. We update the underlying intent model and the radar
    // canvas live, but DO NOT rebuild the DOM list — that would destroy the
    // very element the user is dragging or typing in. Only "change" (fired
    // when the user lets go / blurs / commits) triggers a full re-render.
    listContainer.querySelectorAll('input').forEach(n => {
      n.addEventListener('input', onListInputLive);
      n.addEventListener('change', onListInputCommit);
    });
    listContainer.querySelectorAll('button').forEach(n => {
      n.addEventListener('click', onListInputCommit);
    });
  }

  function onListInputLive(e) {
    const idx = Number(e.target.dataset.idx);
    const kind = e.target.dataset.kind;
    if (!Number.isFinite(idx)) return;
    if (kind === 'label') {
      intent.axes[idx].label = e.target.value;
    } else if (kind === 'value') {
      const v = Number(e.target.value);
      intent.axes[idx].value = v;
      // Live-update the percentage display next to the slider without
      // re-rendering the entire list.
      const valueEl = listContainer.querySelector(`.axis-value[data-idx="${idx}"]`);
      if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
    }
    renderCanvas();
    onChange?.(intent);
  }

  function onListInputCommit(e) {
    const idx = Number(e.target.dataset.idx);
    const kind = e.target.dataset.kind;
    if (!Number.isFinite(idx)) return;
    if (kind === 'label') intent.axes[idx].label = e.target.value;
    if (kind === 'value') intent.axes[idx].value = Number(e.target.value);
    if (kind === 'remove' && intent.axes.length > 3) intent.axes.splice(idx, 1);
    renderCanvas();
    renderList();
    onChange?.(intent);
  }

  function hit(event) {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const angle = Math.atan2(y - cy, x - cx);
    const normalized = (angle + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    const n = intent.axes.length;
    const idx = Math.round(normalized / (Math.PI * 2 / n)) % n;
    const r = Math.min(canvas.width, canvas.height) * 0.32;
    const dist = Math.min(1, Math.hypot(x - cx, y - cy) / r);
    return { idx, value: Math.max(0, Math.min(1, dist)) };
  }

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    const h = hit(e);
    intent.axes[h.idx].value = h.value;
    renderCanvas();
    renderList();
    onChange?.(intent);
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    e.preventDefault();
    const h = hit(e);
    intent.axes[h.idx].value = h.value;
    renderCanvas();
    renderList();
    onChange?.(intent);
  });
  window.addEventListener('pointerup', () => { dragging = false; });

  summaryTextarea.addEventListener('input', () => {
    intent.summary = summaryTextarea.value;
    onChange?.(intent);
  });

  function addAxis() {
    intent.axes.push({ id: `axis_${Date.now()}`, label: 'New axis', value: 0.5 });
    renderCanvas();
    renderList();
    onChange?.(intent);
  }

  return { render, addAxis };
}

function wrap(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text).split(' ');
  let line = '', oy = 0;
  for (let n = 0; n < words.length; n++) {
    const test = line + words[n] + ' ';
    if (ctx.measureText(test).width > maxWidth && n > 0) {
      ctx.fillText(line.trim(), x, y + oy);
      line = words[n] + ' ';
      oy += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line.trim(), x, y + oy);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
