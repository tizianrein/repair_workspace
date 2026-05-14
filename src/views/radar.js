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
  let interacting = false;   // true while user is mid-drag / mid-type

  function render(workspace) {
    intent = JSON.parse(JSON.stringify(workspace.intent));
    // Don't clobber the user's input while they're using it.
    if (!interacting) {
      summaryTextarea.value = intent.summary || '';
    }
    renderCanvas();
    if (!interacting) renderList();
  }

  function renderCanvas() {
    if (!intent) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Polygon is small (24% of canvas); labels need room outside (offset
    // ~38px + label width). We clamp label x positions so multi-line wrapped
    // labels can't extend past the canvas edges regardless of alignment.
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.24;
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

    const LABEL_W = 150;        // wrap width in canvas px
    const LABEL_MARGIN = 6;     // keep this far from canvas edge

    axes.forEach((axis, i) => {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.stroke();

      ctx.fillStyle = '#1a1a1a';
      ctx.font = '20px "JetBrains Mono", monospace';
      let lx = cx + Math.cos(a) * (r + 40);
      const ly = cy + Math.sin(a) * (r + 40);
      const align = lx > cx + 6 ? 'left' : lx < cx - 6 ? 'right' : 'center';
      // Clamp so the wrapped label can't extend past the canvas:
      //   left-aligned text grows rightward from lx → cap lx at (w - LABEL_W - margin)
      //   right-aligned text grows leftward from lx → keep lx at >= (LABEL_W + margin)
      if (align === 'left')  lx = Math.min(lx, w - LABEL_W - LABEL_MARGIN);
      if (align === 'right') lx = Math.max(lx, LABEL_W + LABEL_MARGIN);
      ctx.textAlign = align;
      ctx.textBaseline = ly > cy + 6 ? 'top' : ly < cy - 6 ? 'bottom' : 'middle';
      wrap(ctx, axis.label, lx, ly, LABEL_W, 22);
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
      if (n.type === 'range') {
        // Sliders capture pointer during drag. The interaction starts on
        // pointerdown and ends on pointerup (caught either on the slider
        // or via the window-level failsafe).
        n.addEventListener('pointerdown', () => { interacting = true; });
        n.addEventListener('pointerup',   () => { interacting = false; renderList(); });
      } else {
        // Text inputs: interaction starts on focus and ends on blur.
        // Don't use pointerdown/up — releasing the mouse inside a text
        // field doesn't mean typing is finished.
        n.addEventListener('focus', () => { interacting = true; });
        n.addEventListener('blur',  () => { interacting = false; renderList(); });
      }
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
    const r = Math.min(canvas.width, canvas.height) * 0.24;
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

  summaryTextarea.addEventListener('focus', () => { interacting = true; });
  summaryTextarea.addEventListener('blur',  () => { interacting = false; });
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

  // Failsafe (bound once per radar instance): if the pointer is released
  // anywhere on the page, release the interacting flag — UNLESS the user
  // currently has a text input focused (typing isn't a pointer interaction).
  window.addEventListener('pointerup', () => {
    if (!interacting) return;
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT' && active.type === 'text') return;
    if (active && active.tagName === 'TEXTAREA') return;
    interacting = false;
    renderList();
  });

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
