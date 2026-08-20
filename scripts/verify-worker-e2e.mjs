#!/usr/bin/env node
/**
 * End-to-end against a running Worker — real D1, real R2, real HTTP.
 *
 *   npm run cloudflare:migrate:local
 *   npx wrangler dev --config cloudflare/wrangler.jsonc --port 8787
 *   node --env-file=.env.local scripts/verify-worker-e2e.mjs
 *
 * Point it at the deployed Worker with --worker https://…workers.dev to
 * rehearse against production. That writes a throwaway project into the real
 * database; the script deletes the documents it created, but the project row
 * stays, which is why the id is timestamped and obviously disposable.
 *
 * Covers the two things unit tests structurally cannot:
 *
 *  - the corpus round trip through storage. Ingest, store, index, retrieve.
 *    The vectors go into D1 as base64 int8 and come back out through the
 *    Worker's own scoring code, so this is the only test that proves search
 *    ranks correctly in the place it actually runs.
 *  - two clients at once. The 409 path is unit-tested against a fake; here two
 *    real requests race on one row, which is what happens when a participant
 *    has the workshop open in two tabs.
 */

import { buildFixturePdf } from './fixtures/joinery-pdf.mjs';
import { quantizeVector, embedQuery } from '../api/_shared/embeddings.js';
import ingestHandler from '../api/ingest-document.js';

const args = process.argv.slice(2);
const argValue = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const WORKER = (argValue('--worker') || 'http://127.0.0.1:8787').replace(/\/$/, '');
const BASE = `${WORKER}/api/collaboration`;

let passed = 0, failed = 0;
const failures = [];
const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
};
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  ${c.green('PASS')}  ${label}`); }
  else {
    failed++; failures.push(label);
    console.log(`  ${c.red('FAIL')}  ${label}`);
    if (detail !== undefined) console.log(`        ${c.dim(String(detail).slice(0, 400))}`);
  }
  return ok;
}
const section = t => console.log(`\n${c.bold(t)}`);

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

// Run the real ingest handler in-process rather than reimplementing it.
async function ingest(payload) {
  return new Promise((resolveP, rejectP) => {
    const res = {
      _status: 200,
      // The handler is wrapped in withRateLimit, which sets a Retry-After
      // header when it refuses. Without this the shim would throw instead of
      // reporting the refusal.
      setHeader() {},
      status(code) { this._status = code; return this; },
      json(b) { resolveP({ status: this._status, body: b }); return this; },
    };
    Promise.resolve(ingestHandler({ method: 'POST', body: payload }, res)).catch(rejectP);
  });
}

const STAMP = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const PROJECT = `proj_e2e${STAMP}`;

// ingest-document fetches stored documents from the Worker, so it needs to
// know where that is. In production Vercel supplies this; here we point it at
// whichever Worker this run is exercising.
process.env.COLLAB_API_URL = WORKER;

async function uploadDocument({ docId, filename, mimeType, bytes, kind, scope, planId, author }) {
  const q = new URLSearchParams({ scope: scope || 'project', kind: kind || 'reference' });
  if (planId) q.set('planId', planId);
  if (author) q.set('author', author);

  const put = await fetch(`${BASE}/projects/${PROJECT}/corpus/${docId}?${q}`, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'X-File-Name': encodeURIComponent(filename),
      'X-Author-Name': encodeURIComponent(author || ''),
    },
    body: bytes,
  });
  if (!put.ok) return { ok: false, status: put.status, detail: (await put.text()).slice(0, 300) };

  // The address, not the bytes — the path the browser now takes. The document
  // was just stored above, so the function fetches it from R2 itself. Sending
  // base64 through the request body capped documents at ~3.3 MB, because a
  // Vercel body may be 4.5 MB and base64 inflates by 4/3.
  const ingested = await ingest({
    projectId: PROJECT,
    docId,
    docKind: kind || 'reference',
    artefactName: 'Timber-framed barn, south wall sill',
  });
  if (ingested.status !== 200) return { ok: false, status: ingested.status, detail: JSON.stringify(ingested.body).slice(0, 300) };

  const text = await api(`/projects/${PROJECT}/corpus/${docId}/text`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'ready',
      summary: ingested.body.summary,
      text: ingested.body.text,
      keyFacts: ingested.body.keyFacts,
      chunks: ingested.body.chunks,
    }),
  });
  return { ok: text.status === 200, status: text.status, detail: JSON.stringify(text.body).slice(0, 300), chunks: (ingested.body.chunks || []).length };
}

async function search(query, { planId, authorKey, raw = false } = {}) {
  const vector = await embedQuery(query);
  if (!vector) return { status: 0, body: { chunks: [] } };
  return api(`/projects/${PROJECT}/corpus/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `raw: true` posts the float vector an older API build would send. The
    // Worker must cope: the two halves deploy separately and either can lag.
    body: JSON.stringify({ vector: raw ? vector : quantizeVector(vector), planId, authorKey, topK: 8 }),
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(c.bold('\nWorker end-to-end — D1, R2, HTTP'));
  console.log(c.dim(`  worker:  ${WORKER}`));
  console.log(c.dim(`  project: ${PROJECT}\n`));

  const health = await api('/health');
  if (!check(`worker is up (HTTP ${health.status})`, health.status === 200 && health.body.ok, JSON.stringify(health.body))) {
    console.log(c.red('\nStart it with: npx wrangler dev --config cloudflare/wrangler.jsonc --port 8787\n'));
    process.exit(1);
  }

  // -- project ---------------------------------------------------------------
  section('Project creation is idempotent');
  const baseWorkspace = {
    schemaVersion: '2.1.0',
    instance: { id: 'inst_e2e', name: 'Timber corner', parts: [{ id: 'sill', name: 'Sill' }] },
    conditions: [], evidence: [], plans: [],
  };
  const created = await api(`/projects/${PROJECT}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E verification', baseWorkspace, sourceType: 'custom' }),
  });
  check('project created', created.status === 200 && created.body.created === true, JSON.stringify(created.body).slice(0, 200));

  // Ten participants all hit this route on load. The second arrival must not
  // overwrite the shared artefact with their own copy.
  const again = await api(`/projects/${PROJECT}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'E2E verification',
      baseWorkspace: { ...baseWorkspace, instance: { ...baseWorkspace.instance, name: 'CLOBBERED' } },
      sourceType: 'custom',
    }),
  });
  check('second create is a no-op, not an overwrite',
    again.status === 200 && again.body.created === false
      && again.body.project?.baseWorkspace?.instance?.name === 'Timber corner',
    JSON.stringify(again.body?.project?.baseWorkspace?.instance).slice(0, 200));

  // -- corpus ----------------------------------------------------------------
  section('Corpus round trip — ingest, store, index, retrieve');
  console.log(c.dim('        ingesting two documents (real Gemini calls) ...'));

  const joinery = await uploadDocument({
    docId: 'doc_joinery_e2e', filename: 'technical-note-14.pdf', mimeType: 'application/pdf',
    bytes: buildFixturePdf(), kind: 'technique', scope: 'project',
  });
  check(`joinery PDF stored and indexed (${joinery.chunks || 0} chunks)`, joinery.ok, joinery.detail);

  const masonryText = [
    '# Repointing rubble stone walling in lime mortar',
    '',
    'Mortar joints in rubble walling weather back over time. Where the mortar has',
    'eroded more than 20mm behind the face of the stone, or has been repointed in',
    'cement that is now cracking away from the arris, repointing is warranted.',
    '',
    'Rake out by hand to twice the joint width. Never use an angle grinder.',
    'A 1:2.5 lime putty to sharp sand mix suits most rubble walling. Protect from',
    'frost for 72 hours. Rising damp at the base of a wall is more often a failed',
    'drain than a failure of the mortar.',
  ].join('\n');
  const masonry = await uploadDocument({
    docId: 'doc_masonry_e2e', filename: 'guidance-note-6.md', mimeType: 'text/markdown',
    bytes: Buffer.from(masonryText, 'utf-8'), kind: 'reference', scope: 'project',
  });
  check(`masonry note stored and indexed (${masonry.chunks || 0} chunks)`, masonry.ok, masonry.detail);

  // The inline form stays supported — a direct API caller, or anything that
  // has bytes but no stored document, still needs it.
  const inline = await ingest({
    file: { name: 'inline.md', mimeType: 'text/markdown', data: Buffer.from('# Note\n\nA short filed note about lime mortar.', 'utf-8').toString('base64') },
    docKind: 'reference',
  });
  check('the inline-bytes form still works for direct callers',
    inline.status === 200 && (inline.body.summary || '').length > 20,
    JSON.stringify(inline.body).slice(0, 200));

  // An address that does not resolve must fail loudly rather than silently
  // producing an empty document.
  const missing = await ingest({ projectId: PROJECT, docId: 'doc_does_not_exist', docKind: 'reference' });
  check('an unresolvable document id is reported, not swallowed',
    missing.status >= 400, `status ${missing.status}: ${JSON.stringify(missing.body).slice(0, 160)}`);

  const listed = await api(`/projects/${PROJECT}/corpus`);
  check('both documents listed', (listed.body.documents || []).length >= 2,
    JSON.stringify(listed.body).slice(0, 300));
  const ready = (listed.body.documents || []).filter(d => d.status === 'ready');
  check(`both documents reached status "ready" (${ready.length})`, ready.length >= 2,
    (listed.body.documents || []).map(d => `${d.id}:${d.status}`).join(', '));

  section('Semantic search through the Worker');
  const probes = [
    { q: 'the sill end is rotten over 400mm but the rest of the beam is sound', expect: 'doc_joinery_e2e' },
    { q: 'der Balkenkopf ist verfault, der Rest ist gesund', expect: 'doc_joinery_e2e' },
    { q: 'the mortar between the stones is washed out and crumbling', expect: 'doc_masonry_e2e' },
  ];
  for (const { q, expect } of probes) {
    const res = await search(q);
    const chunks = res.body.chunks || [];
    const top = chunks[0];
    console.log(`\n  Q: ${q}`);
    for (const ch of chunks.slice(0, 3)) {
      console.log(c.dim(`     ${(ch.score ?? 0).toFixed(3)}  [${ch.docId}/${ch.chunkKind}] ${String(ch.content || '').replace(/\s+/g, ' ').slice(0, 70)}`));
    }
    check(`ranked ${expect} first`, top?.docId === expect,
      res.body.unavailable ? 'search reported unavailable — is migration 0004 applied?' : `got ${top?.docId} (searched ${res.body.searched})`);
    // Distinct scores are the signal that ranking actually happened. A uniform
    // score means the query vector collapsed and the sort did nothing.
    const distinct = new Set(chunks.map(ch => Number(ch.score).toFixed(6))).size;
    check(`scores are distinct, so ranking is real (${distinct} of ${chunks.length})`,
      chunks.length < 2 || distinct > 1,
      chunks.map(ch => ch.score).join(', '));
  }

  section('Worker tolerates an un-quantised query from an older API build');
  const rawRes = await search(probes[0].q, { raw: true });
  check('raw float query still ranks the joinery document first',
    (rawRes.body.chunks || [])[0]?.docId === 'doc_joinery_e2e',
    `got ${(rawRes.body.chunks || [])[0]?.docId}`);

  // -- scope isolation -------------------------------------------------------
  section('Strategy corpus isolation (the SQL-enforced rule)');
  const strategyDoc = await uploadDocument({
    docId: 'doc_strategy_e2e', filename: 'annas-private-note.md', mimeType: 'text/markdown',
    bytes: Buffer.from(
      'Site note: the client will not accept any visible new timber on the road elevation. '
      + 'Any repair must be concealed behind the existing render and the lime plaster reinstated.',
      'utf-8',
    ),
    kind: 'goal', scope: 'strategy', planId: 'plan_alpha', author: 'anna',
  });
  check('strategy-scoped document stored', strategyDoc.ok, strategyDoc.detail);

  const q = 'the client will not accept visible new timber on the street front';
  const own = await search(q, { planId: 'plan_alpha', authorKey: 'anna' });
  check('the owning strategy can see its own document',
    (own.body.chunks || []).some(ch => ch.docId === 'doc_strategy_e2e'),
    (own.body.chunks || []).map(ch => ch.docId).join(', '));

  const sibling = await search(q, { planId: 'plan_beta', authorKey: 'anna' });
  check('a sibling strategy of the same author cannot',
    !(sibling.body.chunks || []).some(ch => ch.docId === 'doc_strategy_e2e'),
    (sibling.body.chunks || []).map(ch => ch.docId).join(', '));

  const otherAuthor = await search(q, { planId: 'plan_alpha', authorKey: 'bruno' });
  check('another participant cannot, even with the same plan id',
    !(otherAuthor.body.chunks || []).some(ch => ch.docId === 'doc_strategy_e2e'),
    (otherAuthor.body.chunks || []).map(ch => ch.docId).join(', '));

  const unscoped = await search(q);
  check('an unscoped search sees only project documents',
    !(unscoped.body.chunks || []).some(ch => ch.docId === 'doc_strategy_e2e'),
    (unscoped.body.chunks || []).map(ch => ch.docId).join(', '));

  // -- concurrency -----------------------------------------------------------
  section('Two clients at once');
  const layerOf = note => ({
    schemaVersion: '2.1.0',
    instance: { id: 'inst_e2e', name: 'Timber corner', parts: [{ id: 'sill', name: 'Sill' }] },
    conditions: [{ id: `cond_${note}`, type: 'decay', note }],
    evidence: [], plans: [], conversations: [], executionLog: [],
  });
  // baseRev undefined is dropped by JSON.stringify, which is what the client
  // sends for a deliberate overwrite. Passing null instead would arrive as 0.
  const putLayer = (name, layer, baseRev) => api(`/projects/${PROJECT}/layers/${encodeURIComponent(name.toLowerCase())}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorName: name, layer, baseRev }),
  });

  const first = await putLayer('Anna', layerOf('first'), null);
  check(`first write accepted (rev ${first.body.rev})`, first.status === 200, JSON.stringify(first.body).slice(0, 200));
  const rev = first.body.rev;

  // Two tabs, same participant, both believing they hold rev N. Exactly one
  // may win; the loser must be told, not silently discarded.
  const [tabA, tabB] = await Promise.all([
    putLayer('Anna', layerOf('tab-a'), rev),
    putLayer('Anna', layerOf('tab-b'), rev),
  ]);
  const statuses = [tabA.status, tabB.status].sort();
  check(`one write won and one got 409 (${statuses.join(' / ')})`,
    statuses[0] === 200 && statuses[1] === 409,
    JSON.stringify({ a: tabA.body, b: tabB.body }).slice(0, 300));

  const survivor = await api(`/projects/${PROJECT}/layers/anna`);
  const note = survivor.body.layer?.conditions?.[0]?.note;
  check(`the winner's work is what is stored ("${note}")`,
    note === 'tab-a' || note === 'tab-b', JSON.stringify(survivor.body).slice(0, 200));

  // The losing tab must be able to get out of the conflict. Retrying with the
  // same stale baseRev cannot do it — that is the trap the UI used to promise
  // its way into — so the recovery is a write with no baseRev at all.
  const staleRetry = await putLayer('Anna', layerOf('loser-retry'), rev);
  check('retrying with the stale revision still conflicts', staleRetry.status === 409,
    JSON.stringify(staleRetry.body).slice(0, 200));

  const overwrite = await putLayer('Anna', layerOf('loser-overwrite'), undefined);
  check('a deliberate overwrite (no baseRev) resolves the conflict', overwrite.status === 200,
    JSON.stringify(overwrite.body).slice(0, 200));
  const afterOverwrite = await api(`/projects/${PROJECT}/layers/anna`);
  check('the overwriting version is what is stored',
    afterOverwrite.body.layer?.conditions?.[0]?.note === 'loser-overwrite',
    JSON.stringify(afterOverwrite.body.layer?.conditions).slice(0, 200));

  // A null baseRev is not the same as an absent one, and the difference is
  // silent. Pinned here so nobody "tidies" the client into sending null.
  const nulled = await putLayer('Anna', layerOf('nulled'), null);
  check('a null baseRev is read as revision 0, not as an overwrite', nulled.status === 409,
    JSON.stringify(nulled.body).slice(0, 200));

  // Two different participants must never contend — separate rows entirely.
  const [anna, bruno] = await Promise.all([
    putLayer('Anna', layerOf('anna-2'), undefined),
    putLayer('Bruno', layerOf('bruno-1'), undefined),
  ]);
  check('two different participants write concurrently without conflict',
    anna.status === 200 && bruno.status === 200,
    JSON.stringify({ anna: anna.status, bruno: bruno.status }));

  const roster = await api(`/projects/${PROJECT}/layers`);
  const names = (roster.body.layers || []).map(l => l.authorName).sort();
  check(`roster lists both participants (${names.join(', ')})`, names.length === 2, JSON.stringify(roster.body).slice(0, 300));

  // -- spend limits ----------------------------------------------------------
  section('Spend limits');
  const limitCall = (body) => api('/limit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // A fresh bucket name per run, or yesterday's counts would decide today's
  // result.
  const bucket = `e2e${STAMP}`;
  const base = { name: bucket, limit: 3, globalLimit: 100, windowSeconds: 60, cost: 1 };

  const verdicts = [];
  for (let i = 0; i < 4; i++) verdicts.push((await limitCall({ ...base, caller: '1.2.3.4' })).body);
  check('the first three are allowed, the fourth is not',
    verdicts.slice(0, 3).every(v => v.ok === true) && verdicts[3].ok === false,
    JSON.stringify(verdicts));
  check('a refusal says when to try again',
    Number(verdicts[3].retryAfter) > 0 && Number(verdicts[3].retryAfter) <= 60,
    JSON.stringify(verdicts[3]));

  const otherCaller = await limitCall({ ...base, caller: '9.9.9.9' });
  check('a different caller has its own allowance', otherCaller.body.ok === true,
    JSON.stringify(otherCaller.body));

  // The ceiling that actually bounds the bill: a leaked URL does not arrive
  // from one address, so the per-caller limit alone would not stop it.
  const globalBucket = `e2eglobal${STAMP}`;
  const globalVerdicts = [];
  for (let i = 0; i < 4; i++) {
    globalVerdicts.push((await limitCall({
      name: globalBucket, caller: `10.0.0.${i}`, limit: 1000, globalLimit: 3, windowSeconds: 60, cost: 1,
    })).body);
  }
  check('the global ceiling stops distinct callers in aggregate',
    globalVerdicts[3].ok === false && globalVerdicts[3].scope === 'global',
    JSON.stringify(globalVerdicts));

  // Cost weighting: an image generation must count for more than a chat turn.
  const costBucket = `e2ecost${STAMP}`;
  const expensive = await limitCall({ name: costBucket, caller: 'x', limit: 5, globalLimit: 100, windowSeconds: 60, cost: 3 });
  check('a costly call consumes more of the allowance', expensive.body.count === 3,
    JSON.stringify(expensive.body));

  // And the wrapper the endpoints actually use.
  const { withRateLimit, COSTS } = await import('../api/_shared/rate-limit.js');
  const previousEnv = process.env.COLLAB_API_URL;
  process.env.COLLAB_API_URL = WORKER;
  const wrapperBucket = `chat`;
  COSTS[wrapperBucket] = { limit: 2, globalLimit: 100, cost: 1 };

  let handlerRuns = 0;
  const wrapped = withRateLimit(wrapperBucket, async (_req, res) => {
    handlerRuns += 1;
    return res.status(200).json({ ok: true });
  });
  const fakeReq = caller => ({ method: 'POST', headers: { 'x-forwarded-for': caller } });
  const fakeRes = () => {
    const r = { _status: 200, _body: null, _headers: {} };
    r.setHeader = (k, v) => { r._headers[k] = v; };
    r.status = code => { r._status = code; return r; };
    r.json = body => { r._body = body; return r; };
    return r;
  };

  const caller = `wrapper-${STAMP}`;
  const responses = [];
  for (let i = 0; i < 3; i++) {
    const r = fakeRes();
    await wrapped(fakeReq(caller), r);
    responses.push(r);
  }
  check('the wrapper lets the allowed calls through',
    responses.slice(0, 2).every(r => r._status === 200), responses.map(r => r._status).join(','));
  check('the wrapper answers 429 once the limit is passed', responses[2]._status === 429,
    JSON.stringify(responses[2]._body));
  check('a refused request never reaches the handler, so it costs nothing',
    handlerRuns === 2, `handler ran ${handlerRuns} times`);
  check('the 429 carries Retry-After', !!responses[2]._headers['Retry-After'],
    JSON.stringify(responses[2]._headers));

  // Fail open: an unreachable Worker must not take the assistant down with it.
  process.env.COLLAB_API_URL = 'http://127.0.0.1:9';
  const openRes = fakeRes();
  await wrapped(fakeReq(caller), openRes);
  check('an unreachable limiter fails open rather than blocking work',
    openRes._status === 200, JSON.stringify(openRes._body));
  process.env.COLLAB_API_URL = previousEnv;

  // -- tidy up ---------------------------------------------------------------
  section('Cleanup');
  for (const docId of ['doc_joinery_e2e', 'doc_masonry_e2e', 'doc_strategy_e2e']) {
    const del = await api(`/projects/${PROJECT}/corpus/${docId}`, { method: 'DELETE' });
    check(`deleted ${docId}`, del.status === 200, JSON.stringify(del.body).slice(0, 200));
  }
  const afterDelete = await search(probes[0].q);
  check('deleted documents leave no orphaned vectors behind',
    !(afterDelete.body.chunks || []).some(ch => ch.docId === 'doc_joinery_e2e'),
    `searched ${afterDelete.body.searched}`);

  console.log(`\n${c.bold('Result')}  ${c.green(passed + ' passed')}, ${failed ? c.red(failed + ' failed') : '0 failed'}`);
  if (failed) {
    console.log(c.red('\nFailed:'));
    for (const f of failures) console.log(c.red(`  - ${f}`));
    console.log('');
    process.exit(1);
  }
  console.log(c.dim(`\n  Left behind: project row ${PROJECT} and two layers. Harmless, but disposable.\n`));
}

main().catch(err => { console.error(c.red('\nHarness error:'), err); process.exit(1); });
