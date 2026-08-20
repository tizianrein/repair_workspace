/**
 * Corpus tests.
 *
 * The behaviour that matters most here is scope isolation. Project documents
 * are shared so that divergence between participants comes from what they do
 * with the material rather than from having different material; strategy
 * documents belong to one plan so that two strategies genuinely reason from
 * different evidence. If either half leaks, the corpus stops doing its job —
 * and a leak is silent, so it needs a test rather than an inspection.
 */

import assert from 'node:assert';
import { createCorpus, formatSize, newDocId, DOC_KINDS } from '../src/core/corpus.js';

console.log('\n=== CORPUS ===\n');

// --- ids and formatting ---------------------------------------------------
{
  const ids = new Set();
  for (let i = 0; i < 20000; i++) ids.add(newDocId());
  assert.strictEqual(ids.size, 20000, 'document ids do not collide');
  assert.strictEqual(formatSize(512), '512 B');
  assert.strictEqual(formatSize(2048), '2 KB');
  assert.strictEqual(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.deepStrictEqual(DOC_KINDS.map(k => k.value), ['structure', 'goal', 'technique', 'reference']);
  console.log('  ✓ ids are unique and sizes format for the document list');
}

// --- a fake worker that enforces the same scoping rules -------------------
function fakeApi() {
  const docs = [];
  return {
    docs,
    async listCorpus(projectId, { planId, authorKey } = {}) {
      return docs.filter(d =>
        d.projectId === projectId && (
          d.scope === 'project'
          || (d.scope === 'strategy' && d.planId === planId && d.authorKey === authorKey)
        ));
    },
    async putCorpusDoc(projectId, docId, body, meta) {
      docs.push({
        projectId, id: docId, byteSize: body.byteLength ?? 0, status: 'uploaded',
        summary: null, keyFacts: [], docKind: meta.docKind, filename: meta.filename,
        scope: meta.scope, planId: meta.planId, authorKey: meta.authorKey,
        authorName: meta.authorName,
      });
      return { document: docs[docs.length - 1] };
    },
    async putCorpusText(projectId, docId, payload) {
      const d = docs.find(x => x.id === docId);
      if (!d) throw new Error('not found');
      if (payload.status === 'failed') { d.status = 'failed'; d.error = payload.error; }
      else { d.status = 'ready'; d.summary = payload.summary; d.keyFacts = payload.keyFacts || []; }
      return { document: d };
    },
    async deleteCorpusDoc(projectId, docId) {
      const i = docs.findIndex(x => x.id === docId);
      if (i >= 0) docs.splice(i, 1);
      return { ok: true };
    },
  };
}

function fakeFile(name, text, type = 'text/plain') {
  const bytes = new TextEncoder().encode(text);
  return { name, type, arrayBuffer: async () => bytes.buffer };
}

// A stub ingest endpoint, so `add()` can be exercised without a network.
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ summary: 'A summary.', text: 'Full text.', keyFacts: ['a fact'] }),
});
globalThis.btoa = globalThis.btoa || (s => Buffer.from(s, 'binary').toString('base64'));

// --- scope isolation ------------------------------------------------------
{
  const api = fakeApi();
  const scope = { planId: 'plan_A', authorKey: 'anna', authorName: 'Anna' };
  const corpus = createCorpus({ api, getProjectId: () => 'proj_1', getScope: () => scope });

  await corpus.add(fakeFile('survey.txt', 'the sill was replaced in 1987'), { scope: 'project', docKind: 'structure' });
  await corpus.add(fakeFile('scarf.txt', 'scarf joints'), { scope: 'strategy', docKind: 'technique' });

  scope.planId = 'plan_B';
  corpus.invalidate();
  await corpus.add(fakeFile('consolidants.txt', 'consolidant injection'), { scope: 'strategy', docKind: 'technique' });

  scope.planId = 'plan_A';
  corpus.invalidate();
  let visible = (await corpus.list({ force: true })).map(d => d.filename).sort();
  assert.deepStrictEqual(visible, ['scarf.txt', 'survey.txt'], 'plan A sees its own document plus the project one');
  assert.ok(!visible.includes('consolidants.txt'), "plan A cannot see plan B's document");

  scope.planId = 'plan_B';
  corpus.invalidate();
  visible = (await corpus.list({ force: true })).map(d => d.filename).sort();
  assert.deepStrictEqual(visible, ['consolidants.txt', 'survey.txt'], 'plan B sees its own plus the project one');
  assert.ok(!visible.includes('scarf.txt'), "plan B cannot see plan A's document");
  console.log('  ✓ strategy documents are invisible to sibling strategies');
  console.log('  ✓ project documents are visible to every strategy');
}

// --- a different participant's strategy documents stay theirs -------------
{
  const api = fakeApi();
  const scope = { planId: 'plan_X', authorKey: 'anna', authorName: 'Anna' };
  const corpus = createCorpus({ api, getProjectId: () => 'proj_1', getScope: () => scope });
  await corpus.add(fakeFile('annas.txt', 'annas note'), { scope: 'strategy', docKind: 'reference' });

  // Tobias happens to have a plan with the same id — plan ids live inside each
  // participant's own layer, so a collision is possible and must not leak.
  scope.authorKey = 'tobias';
  corpus.invalidate();
  const visible = (await corpus.list({ force: true })).map(d => d.filename);
  assert.ok(!visible.includes('annas.txt'), 'a same-id plan belonging to someone else sees nothing of theirs');
  console.log('  ✓ strategy documents are scoped by participant as well as plan');
}

// --- the context index is summaries only ---------------------------------
{
  const api = fakeApi();
  const scope = { planId: 'plan_A', authorKey: 'anna', authorName: 'Anna' };
  const corpus = createCorpus({ api, getProjectId: () => 'proj_1', getScope: () => scope });
  await corpus.add(fakeFile('survey.txt', 'x'), { scope: 'project', docKind: 'structure' });

  const index = await corpus.contextIndex();
  assert.strictEqual(index.length, 1, 'ready documents appear in the index');
  assert.strictEqual(index[0].summary, 'A summary.', 'the index carries the summary');
  assert.ok(!('text' in index[0]), 'the index does NOT carry full text — that is the whole point');
  assert.ok(!('content' in index[0]), 'no document body in the per-turn context');
  console.log('  ✓ the chat context carries summaries, never document bodies');
}

// --- a failed ingest keeps the document ----------------------------------
{
  const api = fakeApi();
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'boom' }) });
  const scope = { planId: 'plan_A', authorKey: 'anna', authorName: 'Anna' };
  const corpus = createCorpus({ api, getProjectId: () => 'proj_1', getScope: () => scope });

  await corpus.add(fakeFile('weird.bin', 'x'), { scope: 'project', docKind: 'reference' });
  const docs = await corpus.list({ force: true });
  assert.strictEqual(docs.length, 1, 'the document survives a failed ingest');
  assert.strictEqual(docs[0].status, 'failed', 'and is marked failed rather than silently absent');

  const index = await corpus.contextIndex();
  assert.strictEqual(index.length, 0, 'an unreadable document is not offered to the model');
  console.log('  ✓ a failed ingest keeps the upload and marks it, rather than losing it');
}

// --- strategy documents need a strategy ----------------------------------
{
  const api = fakeApi();
  const corpus = createCorpus({
    api,
    getProjectId: () => 'proj_1',
    getScope: () => ({ planId: null, authorKey: 'anna', authorName: 'Anna' }),
  });
  await assert.rejects(
    () => corpus.add(fakeFile('x.txt', 'x'), { scope: 'strategy' }),
    /strategy/i,
    'refuses a strategy document with no strategy, rather than orphaning it',
  );
  console.log('  ✓ a strategy document without a strategy is refused, not orphaned');
}

console.log('\n✓ Corpus scoping holds\n');
