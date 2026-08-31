/**
 * Repair Workspace — workshop results.
 *
 * A read-only build of the workspace interface over a frozen snapshot of the
 * twelve participant layers. Same shell, same vocabulary: an artefact and its
 * strategies on the left, the model in the middle, parts and conditions on the
 * right. Nothing here writes, and nothing here calls a backend.
 */
import { createViewer, STATUS_COLOR } from './viewer.js';
import { spatialGraph, actionGraph } from './graphs.js';

const $ = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = n => '#' + n.toString(16).padStart(6, '0');
const date = s => s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

let DATA, viewer;
const state = { person: 'all', strategy: null, scope: 'conditions', tab: 'proxy', q: '', filter: 'all' };

init();

async function init() {
  DATA = await (await fetch('./data/exhibit.json')).json();

  viewer = createViewer({
    canvas: $('#scene'),
    wrap: $('#pane-3d'),
    // Tapping the model opens the thing you tapped. The hover chip alone was
    // invisible on a phone, so a tap looked like it did nothing at all.
    onPickPart: p => { selectEntity('part', p.id); openPart(p); },
    onPickCondition: c => { selectEntity('condition', c.id); openCondition(c); },
    onHover: showHover,
  });

  buildChrome();
  buildRoster();
  buildCompare();
  wireTabs();
  wireDrawers();
  wireRightPanel();
  wireHud();
  wireModal();

  wireCompare();

  addEventListener('hashchange', route);
  route();
  loadScan();
}

function wireCompare() {
  const modal = $('#compare-modal');
  const close = () => modal.classList.remove('on');
  $('#fab-compare').addEventListener('click', () => {
    document.body.classList.remove('left-open', 'right-open');
    modal.classList.add('on');
  });
  $('#compare-close').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

// =============================================================== chrome ===
function consoleLine() {
  const t = DATA.meta.totals;
  return `snapshot ${date(DATA.meta.generatedAt)} · ${t.participants} participants · ${t.strategies} strategies`;
}

function buildChrome() {
  const t = DATA.meta.totals;
  $('#artefact-name').textContent = DATA.artefact.name || 'Timber Frame Structure';
  $('#project-title').textContent = DATA.artefact.name || 'Timber Frame Structure';
  $('#artefact-stats').textContent = `${DATA.artefact.parts.length} parts · ${t.conditions} conditions`;
  if (DATA.artefact.cover) {
    const img = $('#artefact-cover img');
    img.src = DATA.artefact.cover;
    $('#artefact-cover').addEventListener('click', () => lightbox(DATA.artefact.cover, 'The artefact before the workshop'));
  } else $('#artefact-cover').remove();

  $('#console').textContent = consoleLine();

  $('#about-body').innerHTML =
    `Twelve practitioners surveyed one timber frame corner on 24 August 2026 and recorded `
    + `${t.conditions} conditions and ${t.strategies} strategies with ${t.steps} planned steps between them. `
    + `Nothing here is averaged: every condition and every strategy belongs to one named person.<br><br>`
    + `A frozen snapshot of <b>${esc(DATA.meta.projectId)}</b>, taken ${esc(date(DATA.meta.generatedAt))}. `
    + `Where a strategy has no image, the target state its author recorded is shown in its place.`;

  document.querySelectorAll('.section-label[data-toggle]').forEach(lab => {
    lab.addEventListener('click', () => lab.parentElement.classList.toggle('collapsed'));
  });
}

// ============================================================== routing ===
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function route() {
  const seg = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  state.person = seg[0] === 'p' && seg[1] ? seg[1] : 'all';
  state.strategy = seg[2] === 's' ? seg[3] : null;
  if (state.person !== 'all' && !personBy(state.person)) state.person = 'all';
  render();
  const p = personBy(state.person);
  const s = state.strategy ? p?.strategies.find(x => x.id === state.strategy) : null;
  if (s) openStrategy(p, s);
  else {
    // Navigating away from a strategy must take its modal with it.
    hideModal();
    state.strategy = null;
    viewer.setHighlight(null);
  }
}

function hideModal() { $('#detail-modal').classList.remove('on'); }

const personBy = k => DATA.participants.find(p => p.key === k);
const current = () => state.person === 'all' ? null : personBy(state.person);

/**
 * How a member is coloured.
 *
 * A member that is absent, new, or already repaired keeps that state whatever
 * anyone recorded on it: a confirmed condition reading "Missing member" must
 * not repaint a missing rail as merely damaged. Only where the artefact makes
 * no such claim does the survey decide.
 */
const KEEP_DECLARED = new Set(['missing', 'new', 'repaired', 'discarded']);

function statusFor(declared, conditions) {
  if (KEEP_DECLARED.has(declared)) return declared;
  if (conditions.some(c => c.status === 'confirmed')) return 'defective';
  if (conditions.some(c => c.status === 'suspected')) return 'suspected';
  return declared || 'intact';
}

function currentParts() {
  const p = current();
  if (p) return p.parts;
  const conds = allConditions();
  return DATA.artefact.parts.map(part => {
    const mine = conds.filter(c => c.partRef === part.id);
    return {
      ...part,
      status: statusFor(part.declaredStatus, mine),
      conditionIds: mine.map(c => c.id),
    };
  });
}

const allConditions = () =>
  DATA.participants.flatMap(p => p.conditions.map(c => ({ ...c, _who: p.name, _key: p.key })));

function currentConditions() {
  const p = current();
  return p ? p.conditions.map(c => ({ ...c, _who: p.name, _key: p.key })) : allConditions();
}

// ================================================================ render ===
function render() {
  const p = current();
  $('#viewing-btn').textContent = p ? p.name : 'everyone';
  viewer.setModel(currentParts(), currentConditions());
  renderRoster();
  renderStrategies();
  renderIntent();
  renderEntities();
  if (state.tab === 'spatial') drawSpatial();
  if (state.tab === 'action') drawAction();
}

// ---- roster -------------------------------------------------------------
function buildRoster() {
  const wrap = $('#roster');
  const rows = [{ key: 'all', name: 'Everyone', meta: `${DATA.meta.totals.conditions} conditions` },
    ...DATA.participants.map(p => ({
      key: p.key, name: p.name,
      meta: `${p.counts.conditions} cond · ${p.counts.strategies} strat`,
      empty: !p.counts.conditions && !p.counts.strategies,
    }))];
  for (const r of rows) {
    const b = el('button', 'roster-row' + (r.empty ? ' empty' : ''));
    b.dataset.key = r.key;
    b.append(el('span', 'roster-name', r.name), el('span', 'roster-meta', r.meta));
    b.addEventListener('click', () => go(r.key === 'all' ? '#/' : `#/p/${r.key}`));
    wrap.append(b);
  }
}

function renderRoster() {
  for (const b of $('#roster').children) b.classList.toggle('current', b.dataset.key === state.person);
}

// ---- strategies ---------------------------------------------------------
function renderStrategies() {
  const wrap = $('#strategy-list');
  wrap.replaceChildren();
  const p = current();
  if (!p) {
    wrap.append(el('p', 'strategy-empty', 'Pick a participant to see the strategies they wrote. Compare shows all forty-two at once.'));
    return;
  }
  if (!p.strategies.length) {
    wrap.append(el('p', 'strategy-empty', `${p.name} recorded no strategies.`));
    return;
  }
  for (const s of p.strategies) {
    const item = el('div', 'strategy-item' + (s.id === state.strategy ? ' current' : ''));
    item.style.setProperty('--strategy-color', s.color || 'var(--info)');
    const main = el('div', 'strategy-main');
    main.append(el('div', 'strategy-label', s.label),
                el('div', 'strategy-meta', `${s.steps.length} steps · ${s.status}`));
    item.append(main);
    item.addEventListener('click', () => openStrategy(p, s));
    wrap.append(item);
  }
}

// ---- intent -------------------------------------------------------------
/**
 * Which strategy the intent panel and the action view are showing.
 *
 * With nothing picked, default to a plan that actually has steps. Seven of the
 * twelve participants left their first strategy at intent, so defaulting to
 * index zero showed an empty action view for most of the room.
 */
function activeStrategy() {
  const p = current();
  if (!p) return null;
  if (state.strategy) {
    const picked = p.strategies.find(s => s.id === state.strategy);
    if (picked) return picked;
  }
  return p.strategies.find(s => s.steps.length) || p.strategies[0] || null;
}

/** With nobody selected the action view still shows a plan: the longest one. */
function featuredPlan() {
  let best = null;
  for (const p of DATA.participants) {
    for (const s of p.strategies) {
      if (!best || s.steps.length > best.s.steps.length) best = { p, s };
    }
  }
  return best && best.s.steps.length ? best : null;
}

function renderIntent() {
  const s = activeStrategy();
  const rw = $('#radar-wrap'), al = $('#axis-list'), cs = $('#constraints');
  rw.replaceChildren(); al.replaceChildren(); cs.replaceChildren();
  if (!s) {
    al.append(el('p', 'strategy-empty', 'No strategy selected.'));
    cs.append(el('p', 'strategy-empty', '—'));
    return;
  }
  const colour = s.color || '#1f4e79';
  rw.append(radar(s.intent?.axes || [], colour, 150));
  for (const a of (s.intent?.axes || [])) {
    const weighed = typeof a.value === 'number' && isFinite(a.value);
    const row = el('div', 'axis-row ro' + (weighed ? '' : ' unweighed'));
    row.style.setProperty('--strategy-color', colour);
    row.append(el('div', 'axis-name', a.label), el('div', 'axis-value', weighed ? a.value.toFixed(2) : '—'));
    const track = el('div', 'axis-track');
    const fill = el('i'); fill.style.width = `${(weighed ? a.value : 0) * 100}%`;
    track.append(fill);
    row.append(track);
    al.append(row);
  }
  const entries = Object.entries(s.constraints || {});
  if (!entries.length) cs.append(el('p', 'strategy-empty', 'None recorded.'));
  for (const [k, v] of entries) {
    const f = el('div', 'field');
    f.append(el('label', null, k.replace(/_/g, ' ')), el('div', 'object-input', String(v)));
    cs.append(f);
  }
}

// ---- right drawer -------------------------------------------------------
function wireRightPanel() {
  $('#scope').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.scope = b.dataset.scope;
    for (const x of $('#scope').children) x.classList.toggle('active', x === b);
    state.filter = 'all';
    renderEntities();
  });
  $('#search').addEventListener('input', e => { state.q = e.target.value.toLowerCase(); renderEntities(); });
  $('#filter').addEventListener('change', e => { state.filter = e.target.value; renderEntities(); });
  $('#viewing-btn').addEventListener('click', () => {
    $('#sec-people').classList.remove('collapsed');
    document.body.classList.remove('right-open');
    document.body.classList.add('left-open');
    $('#roster').scrollIntoView({ block: 'nearest' });
  });
}

function renderEntities() {
  const list = $('#entity-list');
  list.replaceChildren();
  const conds = currentConditions();
  const parts = currentParts();

  const opts = state.scope === 'conditions'
    ? ['all', 'confirmed', 'suspected', 'refuted']
    : ['all', 'intact', 'defective', 'suspected', 'missing', 'repaired', 'new'];
  const sel = $('#filter');
  sel.replaceChildren();
  for (const o of opts) {
    const op = el('option', null, o === 'all' ? (state.scope === 'conditions' ? 'All conditions' : 'All parts') : o);
    op.value = o;
    sel.append(op);
  }
  sel.value = state.filter;

  const q = state.q;
  let shown = 0;

  if (state.scope === 'conditions') {
    const rows = conds.filter(c =>
      (state.filter === 'all' || c.status === state.filter)
      && (!q || `${c.type} ${c.description} ${c.partRef} ${c._who} ${c.id}`.toLowerCase().includes(q)));
    for (const c of rows) list.append(conditionCard(c));
    shown = rows.length;
    if (!rows.length) list.append(el('div', 'entity-empty', 'Nothing matches.'));
  } else {
    const rows = parts.filter(p =>
      (state.filter === 'all' || p.status === state.filter)
      && (!q || `${p.id} ${p.label} ${p.material}`.toLowerCase().includes(q)));
    for (const p of rows) list.append(partCard(p));
    shown = rows.length;
    if (!rows.length) list.append(el('div', 'entity-empty', 'Nothing matches.'));
  }

  $('#list-count').textContent = String(shown);
  const suspected = conds.filter(c => c.status === 'suspected').length;
  $('#list-footer').textContent =
    `${parts.length} parts · ${conds.length} conditions${suspected ? ` · ${suspected} suspected` : ''}`;
  $('#collab-status').textContent = current()
    ? `layer rev ${current().rev} · last saved ${date(current().updatedAt)}`
    : `${DATA.meta.totals.participants} layers merged for display`;
}

function conditionCard(c) {
  const card = el('div', 'entity-card dmg');
  card.dataset.entity = `condition:${c.id}`;
  const row = el('div', 'ec-row');
  const left = el('div', 'ec-id');
  left.innerHTML = `<span class="ec-type-pill">${esc(c.type || 'condition')}</span>${esc(c.id)}`;
  row.append(left, el('div', `ec-status ${c.status}`, c.status));
  card.append(row);
  const meta = el('div', 'ec-meta');
  meta.textContent = `on ${c.partRef || '—'} · ${c.description || ''}`;
  card.append(meta);
  if (c._who) card.append(el('span', 'ec-author', `by ${c._who}`));
  card.addEventListener('click', () => {
    viewer.focusCondition(c.id);
    if (c.partRef) viewer.selectPart(c.partRef);
    selectEntity('condition', c.id);
    openCondition(c);
  });
  return card;
}

function partCard(p) {
  const card = el('div', 'entity-card');
  card.dataset.entity = `part:${p.id}`;
  const row = el('div', 'ec-row');
  row.append(el('div', 'ec-id', p.id), el('div', `ec-status ${p.status}`, p.status));
  card.append(row);
  if (p.material || p.conditionIds?.length) {
    card.append(el('div', 'ec-meta',
      [p.material, p.conditionIds?.length ? `${p.conditionIds.length} condition${p.conditionIds.length === 1 ? '' : 's'}` : null]
        .filter(Boolean).join(' · ')));
  }
  card.addEventListener('click', () => { viewer.focusPart(p.id); selectEntity('part', p.id); openPart(p); });
  return card;
}

function selectEntity(kind, id) {
  for (const c of document.querySelectorAll('.entity-card')) {
    c.classList.toggle('selected', c.dataset.entity === `${kind}:${id}`);
  }
  const hit = document.querySelector(`.entity-card[data-entity="${kind}:${id}"]`);
  if (hit) hit.scrollIntoView({ block: 'nearest' });
}

// =============================================================== modal ====
function wireModal() {
  $('#modal-close').addEventListener('click', closeModal);
  $('#detail-modal').addEventListener('click', e => { if (e.target.id === 'detail-modal') closeModal(); });
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) return ($('#lightbox').hidden = true);
    closeModal();
  });
}
function closeModal() {
  hideModal();
  state.strategy = null;
  history.replaceState(null, '', state.person === 'all' ? '#/' : `#/p/${state.person}`);
  renderStrategies();
  viewer.setHighlight(null);
}

function openStrategy(person, s) {
  state.strategy = s.id;
  history.replaceState(null, '', `#/p/${person.key}/s/${s.id}`);
  renderStrategies();
  renderIntent();
  viewer.setHighlight(s.affectedParts);
  if (state.tab === 'action') drawAction();

  const body = openModal(s.label);

  const head = el('div', 'detail-box');
  head.append(el('div', 'label', `${person.name} · ${s.steps.length} steps · ${s.status} · updated ${date(s.updatedAt)}`));
  if (s.intent?.summary) head.append(el('div', 'value', s.intent.summary));
  body.append(head);

  if (s.steps.length) {
    body.append(el('div', 'modal-section-label', 'Planned steps'));
    s.steps.forEach((st, i) => body.append(stepCard(person, st, i)));
  } else {
    body.append(el('p', 'absent-line', 'Intent was set; no steps were planned before the session ended.'));
  }

  const shots = person.evidence.filter(e => e.kind === 'rendering');
  if (shots.length) {
    const have = shots.filter(e => e.file).length;
    body.append(el('div', 'modal-section-label', have ? 'Imagined results' : 'Intended result'));
    body.append(gallery(shots));
  }
  $('#detail-modal').classList.add('on');
}

/** Every image anyone attached to this condition. */
function evidenceFor(condition) {
  const owners = condition._key ? [personBy(condition._key)] : DATA.participants;
  const refs = new Set(condition.evidenceRefs || []);
  const out = [];
  for (const p of owners.filter(Boolean)) {
    for (const e of p.evidence) {
      const attached = e.attachedTo?.type === 'condition' && e.attachedTo.id === condition.id;
      if (attached || refs.has(e.id) || e.confirms === condition.id || e.refutes === condition.id) out.push(e);
    }
  }
  return out;
}

function openModal(title) {
  document.body.classList.remove('left-open', 'right-open');
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.replaceChildren();
  $('#detail-modal').classList.add('on');
  return body;
}

function openCondition(c) {
  const body = openModal(c.type || 'Condition');

  const box = el('div', 'detail-box');
  const head = el('div', 'ec-row');
  head.append(el('div', 'ec-id', c.id), el('div', `ec-status ${c.status}`, c.status));
  box.append(head);
  if (c.description) box.append(el('div', 'value', c.description));
  body.append(box);

  const facts = el('div', 'detail-grid');
  const fact = (k, v) => {
    const f = el('div', 'detail-box');
    f.append(el('div', 'label', k), el('div', 'value', v));
    return f;
  };
  facts.append(fact('on member', c.partRef || '—'));
  if (typeof c.confidence === 'number') facts.append(fact('confidence', `${Math.round(c.confidence * 100)}%`));
  facts.append(fact('recorded by', c._who || '—'));
  facts.append(fact('recorded', date(c.createdAt)));
  body.append(facts);

  const shots = evidenceFor(c);
  body.append(el('div', 'modal-section-label', shots.length ? 'Evidence' : 'Evidence'));
  body.append(shots.length ? gallery(shots) : el('p', 'absent-line', 'No evidence was attached to this condition.'));

  // Which plans actually respond to it.
  const answering = [];
  for (const p of DATA.participants) {
    for (const s of p.strategies) {
      const hits = s.steps.filter(st => (st.addressesConditionRefs || []).includes(c.id));
      if (hits.length) answering.push({ p, s, hits });
    }
  }
  if (answering.length) {
    body.append(el('div', 'modal-section-label', 'Addressed by'));
    for (const { p, s, hits } of answering) {
      const item = el('div', 'strategy-item');
      item.style.setProperty('--strategy-color', s.color || 'var(--info)');
      const main = el('div', 'strategy-main');
      main.append(el('div', 'strategy-label', s.label),
                  el('div', 'strategy-meta', `${p.name} · ${hits.length} of ${s.steps.length} steps`));
      item.append(main);
      item.addEventListener('click', () => go(`#/p/${p.key}/s/${s.id}`));
      body.append(item);
    }
  }

  if (c.partRef) {
    const b = el('button', 'mini-btn', 'show this member in 3D');
    b.addEventListener('click', () => { closeModalKeepStrategy(); setTab('proxy'); viewer.focusPart(c.partRef); });
    body.append(b);
  }
}

function openPart(part) {
  const body = openModal(part.id.replace(/_/g, ' '));

  const box = el('div', 'detail-box');
  const head = el('div', 'ec-row');
  head.append(el('div', 'ec-id', part.id), el('div', `ec-status ${part.status}`, part.status));
  box.append(head);
  body.append(box);

  const d = part.dimensions || {};
  const facts = el('div', 'detail-grid');
  const fact = (k, v) => {
    const f = el('div', 'detail-box');
    f.append(el('div', 'label', k), el('div', 'value', v));
    return f;
  };
  facts.append(fact('size', `${(d.width * 100).toFixed(0)} × ${(d.height * 100).toFixed(0)} × ${(d.depth * 100).toFixed(0)} cm`));
  if (part.material) facts.append(fact('material', part.material));
  facts.append(fact('declared', part.declaredStatus || 'intact'));
  facts.append(fact('meets', String((part.connections || []).length) + ' members'));
  body.append(facts);

  if (part.notes) {
    const n = el('div', 'detail-box');
    n.append(el('div', 'label', 'note on this member'), el('div', 'value', part.notes));
    body.append(n);
  }

  const conds = currentConditions().filter(c => c.partRef === part.id);
  body.append(el('div', 'modal-section-label', 'Conditions on this member'));
  if (!conds.length) body.append(el('p', 'absent-line', 'Nothing was recorded on it.'));
  for (const c of conds) {
    const card = conditionCard(c);
    body.append(card);
  }

  const b = el('button', 'mini-btn', 'show in 3D');
  b.addEventListener('click', () => { closeModalKeepStrategy(); setTab('proxy'); viewer.focusPart(part.id); });
  body.append(b);
}

function openStep(person, strategy, st) {
  const body = openModal(st.title);
  body.append(el('div', 'modal-section-label', `${person.name} · ${strategy.label}`));
  body.append(stepCard(person, st, strategy.steps.indexOf(st)));
}

function stepCard(person, st, i) {
  const card = el('div', 'step-card');
  const head = el('div', 'step-head');
  head.append(el('span', 'step-num', String(i + 1).padStart(2, '0')), el('span', 'step-title', st.title));
  card.append(head);
  if (st.description) card.append(el('p', 'step-desc', st.description));

  const chips = el('div', 'chips');
  for (const r of st.affectedPartRefs || []) {
    const t = el('span', 'chip-tag part', r);
    t.addEventListener('click', () => { viewer.focusPart(r); closeModalKeepStrategy(); });
    chips.append(t);
  }
  for (const r of st.addressesConditionRefs || []) {
    const c = person.conditions.find(x => x.id === r);
    chips.append(el('span', 'chip-tag cond', c ? (c.type || 'condition') : 'condition'));
  }
  if (st.estimatedMinutes) chips.append(el('span', 'chip-tag', `${st.estimatedMinutes} min`));
  for (const t of (st.toolsRequired || []).slice(0, 5)) chips.append(el('span', 'chip-tag', t));
  if (chips.children.length) card.append(chips);

  if (st.justification?.rationale) {
    const why = el('div', 'step-why');
    why.append(el('b', null, 'why this step'), document.createTextNode(st.justification.rationale));
    card.append(why);
  }
  return card;
}

function closeModalKeepStrategy() { hideModal(); }

// ============================================================== gallery ===
function gallery(items) {
  const box = el('div');
  const present = items.filter(e => e.file);
  const absent = items.filter(e => !e.file);

  if (present.length) {
    const grid = el('div', 'shots');
    for (const e of present) {
      const fig = el('figure', 'shot');
      const img = el('img');
      img.src = e.file; img.loading = 'lazy'; img.alt = e.fileName || 'image';
      img.addEventListener('click', () => lightbox(e.file, [e.fileName, date(e.capturedAt)].filter(Boolean).join(' · ')));
      fig.append(img, el('figcaption', null, e.fileName || ''));
      grid.append(fig);
    }
    box.append(grid);
  }

  // Where a picture is not part of the snapshot, the target state recorded
  // beside it stands in its place, on its own terms.
  const described = absent.filter(e => e.kind === 'rendering' && e.sollJson);
  let sink = box;
  if (described.length > 2) {
    const g = el('details', 'absent-group');
    g.append(el('summary', null,
      `${described.length} recorded target states — the repair each step was aiming at`));
    box.append(g);
    sink = g;
  }
  described.forEach((e, i) => {
    const row = el('div', 'absent-row');
    row.append(Object.assign(el('div', 'absent-head'), {
      innerHTML: `<span class="fn">${String(i + 1).padStart(2, '0')} · ${esc(date(e.capturedAt))}</span>`,
    }));
    row.append(soll(e.sollJson, described.length <= 2));
    sink.append(row);
  });
  return box;
}

function soll(s, open = false) {
  const d = el('details', 'soll');
  if (open) d.open = true;
  d.append(el('summary', null, 'the intended result'));
  const b = el('div', 'soll-body');
  const subj = s.subject || {};
  if (subj.overall_condition) b.append(Object.assign(el('p'), { innerHTML: `<b>Result:</b> ${esc(subj.overall_condition)}` }));
  if (subj.material) b.append(Object.assign(el('p'), { innerHTML: `<b>Material:</b> ${esc(subj.material)}` }));
  const parts = (subj.parts || []).filter(p => p.condition);
  if (parts.length) {
    const ul = el('ul');
    for (const p of parts.slice(0, 14)) {
      ul.append(Object.assign(el('li'), {
        innerHTML: `<b>${esc(p.name || p.id)}</b> — ${esc(p.condition)}${p.present === false ? ' (removed)' : ''}`,
      }));
    }
    b.append(ul);
  }
  d.append(b);
  return d;
}

function lightbox(src, name) {
  $('#lightbox-img').src = src;
  $('#lightbox-name').textContent = name || '';
  $('#lightbox').hidden = false;
}

// ============================================================== compare ===
function buildCompare() {
  const grid = $('#compare-grid');
  const all = DATA.participants.flatMap(p => p.strategies.map(s => ({ p, s })));
  all.sort((a, b) => a.p.name.localeCompare(b.p.name) || a.s.label.localeCompare(b.s.label));
  for (const { p, s } of all) {
    const card = el('div', 'entity-card cmp-card');
    card.style.setProperty('--strategy-color', s.color || 'var(--info)');
    card.append(el('div', 'cmp-who', p.name), el('div', 'cmp-label', s.label));
    if (s.intent?.summary) card.append(el('div', 'cmp-sum', s.intent.summary));
    const foot = el('div', 'cmp-foot');
    foot.append(el('span', 'cmp-n', `${s.steps.length} steps`), radar(s.intent?.axes || [], s.color || '#1f4e79', 78));
    card.append(foot);
    card.addEventListener('click', () => {
      $('#compare-modal').classList.remove('on');
      go(`#/p/${p.key}/s/${s.id}`);
    });
    grid.append(card);
  }
}

// ================================================================ radar ===
function radar(axes, colour, size = 150) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', axes.map(a => `${a.label} ${a.value ?? 'unweighed'}`).join(', '));
  const cx = size / 2, cy = size / 2, R = size / 2 - 17, n = axes.length || 1;
  const pt = (i, r) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  for (const ring of [0.33, 0.66, 1]) {
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', Array.from({ length: n }, (_, i) => pt(i, R * ring).join(',')).join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', '#1a1a1a');
    poly.setAttribute('stroke-opacity', ring === 1 ? '.3' : '.12');
    svg.append(poly);
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, R);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', cx); line.setAttribute('y1', cy);
    line.setAttribute('x2', x); line.setAttribute('y2', y);
    line.setAttribute('stroke', '#1a1a1a'); line.setAttribute('stroke-opacity', '.12');
    svg.append(line);
    const [lx, ly] = pt(i, R + 9);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', lx); label.setAttribute('y', ly);
    label.setAttribute('font-size', '7');
    label.setAttribute('font-family', 'var(--mono)');
    label.setAttribute('fill', '#8a8a83');
    label.setAttribute('text-anchor', lx > cx + 2 ? 'start' : lx < cx - 2 ? 'end' : 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    label.textContent = (axes[i].label || '').split(' ').map(w => w[0]).join('').slice(0, 3);
    svg.append(label);
  }
  const shape = document.createElementNS(ns, 'polygon');
  shape.setAttribute('points', axes
    .map(a => (typeof a.value === 'number' && isFinite(a.value)) ? a.value : 0)
    .map((v, i) => pt(i, R * Math.max(v, 0.02)).join(',')).join(' '));
  shape.setAttribute('fill', colour); shape.setAttribute('fill-opacity', '.2');
  shape.setAttribute('stroke', colour); shape.setAttribute('stroke-width', '1.5');
  svg.append(shape);
  return svg;
}

// ============================================================ chrome bits ==
function wireTabs() {
  $('#tab-bar').addEventListener('click', e => {
    const b = e.target.closest('.tab'); if (!b) return;
    setTab(b.dataset.tab);
  });
}

async function setTab(tab) {
  state.tab = tab;
  for (const b of $('#tab-bar').children) b.classList.toggle('active', b.dataset.tab === tab);
  $('#pane-3d').classList.toggle('active', tab === 'proxy');
  $('#pane-spatial').classList.toggle('active', tab === 'spatial');
  $('#pane-action').classList.toggle('active', tab === 'action');
  if (tab === 'spatial') drawSpatial();
  if (tab === 'action') drawAction();
}

/** The scan is the proxy view now, so it loads with the page. */
async function loadScan() {
  const scan = DATA.artefact.scan;
  if (!scan) return;
  const note = $('#console');
  try {
    await viewer.showScan(scan.file, p => {
      if (p.lengthComputable && note) {
        note.textContent = `loading scan ${Math.round((p.loaded / p.total) * 100)}%`;
      }
    });
  } catch { /* boxes remain */ }
  if (note) note.textContent = consoleLine();
}

let cySpatial = null, cyAction = null;

function drawSpatial() {
  const host = $('#spatial-graph-canvas');
  if (cySpatial) { cySpatial.destroy(); cySpatial = null; }
  host.replaceChildren();
  const parts = currentParts();
  cySpatial = spatialGraph(host, parts, {
    onPick: id => {
      viewer.selectPart(id);
      const p = parts.find(x => x.id === id);
      if (p) openPart(p);
    },
  });
  $('#spatial-note').textContent =
    `${parts.length} members · ${current() ? current().name + "'s model" : 'the project model'}`;
}

function drawAction() {
  const host = $('#action-graph-canvas');
  if (cyAction) { cyAction.destroy(); cyAction = null; }
  host.replaceChildren();
  let p = current();
  let s = activeStrategy();
  if (p && !s) {
    $('#action-note').textContent = `${p.name} recorded no strategies.`;
    return;
  }
  if (!p) {
    const pick = featuredPlan();
    if (!pick) { $('#action-note').textContent = ''; return; }
    p = pick.p; s = pick.s;
  }
  cyAction = actionGraph(host, s, {
    onPick: id => {
      const step = s.steps.find(x => x.id === id);
      if (step) openStep(p, s, step);
      else openStrategy(p, s);
    },
  });
  $('#action-note').textContent = s.steps.length
    ? `${p.name} · ${s.label} · ${s.steps.length} steps`
    : `${p.name} · ${s.label} · repair intent`;
}

function wireHud() {
  $('#btn-reset').addEventListener('click', () => viewer.resetView());
  $('#btn-explode').addEventListener('click', e => e.target.classList.toggle('on', viewer.toggleExplode()));
  $('#btn-labels').addEventListener('click', e => e.target.classList.toggle('on', viewer.toggleLabels()));
}

function wireDrawers() {
  const open = side => { document.body.classList.remove('left-open', 'right-open'); document.body.classList.add(`${side}-open`); };
  $('#fab-left').addEventListener('click', () => open('left'));
  $('#fab-right').addEventListener('click', () => open('right'));
  $('#backdrop').addEventListener('click', () => document.body.classList.remove('left-open', 'right-open'));
  for (const b of document.querySelectorAll('[data-close-drawer]')) {
    b.addEventListener('click', () => document.body.classList.remove('left-open', 'right-open'));
  }
  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
}

let hoverTimer;
function showHover(hit) {
  const card = $('#hover-card');
  clearTimeout(hoverTimer);
  if (!hit) { card.hidden = true; return; }
  const d = hit.data;
  card.innerHTML = hit.type === 'part'
    ? `<b>${esc(d.id)}</b><em>${esc(d.status)}${d.material ? ' · ' + esc(d.material) : ''}</em>`
    : `<b>${esc(d.type || 'condition')}</b><em>${esc(d.description || '')}</em>`;
  card.hidden = false;
  const rect = $('#pane-3d').getBoundingClientRect();
  const x = hit.ev ? hit.ev.clientX - rect.left + 14 : 14;
  const y = hit.ev ? hit.ev.clientY - rect.top + 14 : 14;
  card.style.left = `${Math.min(x, rect.width - 250)}px`;
  card.style.top = `${Math.min(y, rect.height - 80)}px`;
  if (hit.sticky) hoverTimer = setTimeout(() => { card.hidden = true; }, 4000);
}
