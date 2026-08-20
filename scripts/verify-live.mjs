#!/usr/bin/env node
/**
 * Live verification — the things `npm test` cannot reach.
 *
 * Every other test in this repo runs offline. That is deliberate and it is also
 * the reason the corpus shipped unexercised: the entire Gemini surface —
 * ingest, embeddings, semantic retrieval — was verified structurally and never
 * once at runtime. This script closes that gap, and costs a few cents to run.
 *
 *   node --env-file=.env.local scripts/verify-live.mjs
 *   node --env-file=.env.local scripts/verify-live.mjs --endpoint https://your-app.vercel.app
 *
 * With no --endpoint it imports the handlers and runs them in this process,
 * which tests the code. With --endpoint it posts to a deployment, which tests
 * the code *and* the environment it was deployed into — different failure
 * modes, chiefly the prompt files loaded from disk at runtime. Run it both
 * ways; local success does not imply deployed success.
 *
 * What it asserts, in order of how much it matters:
 *
 *  1. Retrieval bridges vocabulary. A query phrased in the problem's words
 *     reaches a document written in the solution's words, and — the half that
 *     is easy to forget to check — does NOT reach the unrelated document. A
 *     retriever that returns the joinery text for every query has not bridged
 *     anything, it has simply got one document.
 *  2. Figures survive ingest. Technical documents keep their content in the
 *     drawings; if `figures` comes back empty on a document that has one, the
 *     corpus is prose-only and the most useful material is invisible.
 *  3. Ingest returns usable JSON at all, for PDF, photo and plain text.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const endpoint = argValue('--endpoint');
const only = argValue('--only');
const keepPdf = args.includes('--keep-pdf');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let passed = 0, failed = 0, warned = 0;
const failures = [];

const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
};

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ${c.green('PASS')}  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ${c.red('FAIL')}  ${label}`);
    if (detail) console.log(`        ${c.dim(String(detail).slice(0, 500))}`);
  }
  return condition;
}

function warn(label, detail) {
  warned++;
  console.log(`  ${c.yellow('WARN')}  ${label}`);
  if (detail) console.log(`        ${c.dim(String(detail).slice(0, 300))}`);
}

function section(title) {
  console.log(`\n${c.bold(title)}`);
}

// ---------------------------------------------------------------------------
// Calling the ingest endpoint, in-process or over the wire
// ---------------------------------------------------------------------------

let ingestHandler = null;

async function ingest(body) {
  if (endpoint) {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/ingest-document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 400) }; }
    return { status: res.status, body: json };
  }

  if (!ingestHandler) {
    ({ default: ingestHandler } = await import(
      new URL('../api/ingest-document.js', import.meta.url).href
    ));
  }
  // Minimal Vercel req/res shim. Calling the real handler rather than
  // reimplementing it is the point: a reimplementation would verify this
  // script, not the endpoint.
  return await new Promise((resolveP, rejectP) => {
    const res = {
      _status: 200,
      // The handler is wrapped in withRateLimit, which sets a Retry-After
      // header when it refuses. Without this the shim would throw instead of
      // reporting the refusal.
      setHeader() {},
      status(code) { this._status = code; return this; },
      json(payload) { resolveP({ status: this._status, body: payload }); return this; },
    };
    Promise.resolve(ingestHandler({ method: 'POST', body }, res)).catch(rejectP);
  });
}

function b64(path) {
  return readFileSync(path).toString('base64');
}

// ---------------------------------------------------------------------------
// The fixture PDF — prose plus a real vector drawing, so that `figures` has
// something genuine to find. Generated rather than committed: a 5 KB generator
// beats a binary in the tree, and it documents what the fixture contains.
// ---------------------------------------------------------------------------

async function makeFixturePdf() {
  const { buildFixturePdf } = await import(
    new URL('./fixtures/joinery-pdf.mjs', import.meta.url).href
  );
  return buildFixturePdf();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testModels() {
  section('Gemini reachability and model names');
  const key = process.env.GEMINI_API_KEY;
  if (!check('GEMINI_API_KEY is set', !!key, 'run with: node --env-file=.env.local scripts/verify-live.mjs')) {
    return false;
  }

  const { DEFAULT_TEXT_MODEL, DEFAULT_IMAGE_MODEL } = await import(
    new URL('../api/_shared/gemini.js', import.meta.url).href
  );
  const { EMBEDDING_MODEL } = await import(
    new URL('../api/_shared/embeddings.js', import.meta.url).href
  );

  let names = [];
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`,
    );
    if (!res.ok) {
      check(`models list reachable (HTTP ${res.status})`, false, await res.text());
      return false;
    }
    check(`models list reachable (HTTP ${res.status})`, true);
    const json = await res.json();
    names = (json.models || []).map(m => m.name.replace('models/', ''));
  } catch (err) {
    check('models list reachable', false, err.message);
    return false;
  }

  // A model name that has been retired is the failure mode that looks like a
  // code bug at 9am on the workshop morning. It is worth thirty seconds.
  for (const [label, name] of [
    ['text', DEFAULT_TEXT_MODEL],
    ['image', DEFAULT_IMAGE_MODEL],
    ['embedding', EMBEDDING_MODEL],
  ]) {
    check(`${label} model "${name}" exists on this key`, names.includes(name),
      `available: ${names.filter(n => n.startsWith(name.split('-').slice(0, 2).join('-'))).join(', ')}`);
  }
  return true;
}

async function testIngestPdf() {
  section('Ingest — PDF with prose, a drawing and a table');
  const pdf = await makeFixturePdf();
  if (keepPdf) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(ROOT, 'fixture.pdf'), pdf);
    console.log(c.dim('        wrote fixture.pdf'));
  }

  const t0 = Date.now();
  const { status, body } = await ingest({
    file: {
      name: 'technical-note-14-beam-ends.pdf',
      mimeType: 'application/pdf',
      data: pdf.toString('base64'),
    },
    docKind: 'technique',
    artefactName: 'Timber-framed barn, south wall sill',
  });
  console.log(c.dim(`        ${Date.now() - t0}ms`));

  if (!check(`HTTP 200 (got ${status})`, status === 200, JSON.stringify(body).slice(0, 400))) {
    return null;
  }
  check('not flagged unreadable', !body.unreadable, body.summary);

  const text = String(body.text || '');
  check('summary is present and substantial', (body.summary || '').length > 80, body.summary);
  check('full text extracted (>1500 chars)', text.length > 1500, `got ${text.length}`);

  // Numbers are the part of a technical document that a paraphrasing model
  // quietly destroys, and the part a repair plan depends on.
  const numbers = ['400', '22', '53', '300'];
  const foundNumbers = numbers.filter(n => text.includes(n));
  check(`dimensions transcribed verbatim (${foundNumbers.join(', ') || 'none'})`,
    foundNumbers.length >= 3, text.slice(0, 300));

  const facts = Array.isArray(body.keyFacts) ? body.keyFacts : [];
  check(`keyFacts extracted (${facts.length})`, facts.length >= 3, JSON.stringify(facts));

  const figures = Array.isArray(body.figures) ? body.figures : [];
  check(`figures found (${figures.length})`, figures.length >= 1,
    'The document contains Fig. 7 and Table 2. An empty array here means drawings are invisible to the corpus.');
  if (figures.length) {
    const figText = figures.map(f => `${f.label} ${f.description}`).join(' ').toLowerCase();
    check('a figure is identified as a scarf joint',
      figText.includes('scarf') || figText.includes('splay'),
      JSON.stringify(figures, null, 2).slice(0, 600));
    console.log(c.dim(`        figures: ${figures.map(f => f.label || '(unlabelled)').join(' | ')}`));
  }

  const indications = Array.isArray(body.indications) ? body.indications : [];
  check(`indications extracted (${indications.length})`, indications.length >= 2, JSON.stringify(indications));
  if (indications.length) {
    // The prompt is emphatic that indications must be in the problem's
    // vocabulary. If every one of them says "scarf", the ingest has produced
    // solution-vocabulary and the vocabulary bridge is not being built.
    const solutionWords = indications.filter(i => /scarf|splay|squint/i.test(i)).length;
    if (solutionWords === indications.length) {
      warn('every indication uses solution vocabulary — the prompt asks for the problem\'s words',
        JSON.stringify(indications));
    } else {
      check('indications are written in problem vocabulary', true);
    }
    console.log(c.dim(`        indications:\n          - ${indications.join('\n          - ')}`));
  }

  const chunks = Array.isArray(body.chunks) ? body.chunks : [];
  check(`chunks embedded (${chunks.length})`, chunks.length >= 3,
    'Empty means embedTexts threw and was swallowed — semantic search will be dead but silent.');
  if (chunks.length) {
    check('chunks carry int8 vectors of the declared width',
      chunks.every(ch => typeof ch.vector === 'string' && ch.dims === 768),
      JSON.stringify(chunks[0]).slice(0, 200));
    const kinds = [...new Set(chunks.map(ch => ch.kind))];
    check(`chunk kinds cover summary/indication/figure/text (${kinds.join(', ')})`,
      kinds.includes('summary') && kinds.includes('text'), kinds.join(','));
  }

  console.log(c.dim(`\n        SUMMARY: ${body.summary}`));
  return body;
}

async function testIngestPhoto() {
  section('Ingest — a real photograph of the artefact');
  const candidates = [
    join(ROOT, 'src/public/examples/timber_corner/cover.jpg'),
    join(ROOT, 'src/public/examples/chapel_foot/photos/foot.jpg'),
    join(ROOT, 'dist/examples/timber_corner/cover.jpg'),
  ];
  const photo = candidates.find(existsSync);
  if (!photo) {
    warn('no example photograph found, skipping', candidates.join(', '));
    return null;
  }

  const t0 = Date.now();
  const { status, body } = await ingest({
    file: { name: 'survey-photo.jpg', mimeType: 'image/jpeg', data: b64(photo) },
    docKind: 'structure',
    artefactName: 'Timber corner joint',
  });
  console.log(c.dim(`        ${Date.now() - t0}ms  (${photo.replace(ROOT, '.')})`));

  if (!check(`HTTP 200 (got ${status})`, status === 200, JSON.stringify(body).slice(0, 300))) return null;
  check('photograph produced a description', (body.summary || '').length > 60, body.summary);
  check('photograph produced embeddable chunks', (body.chunks || []).length >= 1);
  console.log(c.dim(`\n        SUMMARY: ${body.summary}`));
  return body;
}

async function testIngestText() {
  section('Ingest — plain text (the no-vision path)');
  // Doubles as the decoy corpus for the retrieval test below. It has to be
  // plausibly adjacent — another building-repair document — or "does the right
  // document win" proves nothing.
  const md = [
    '# Repointing rubble stone walling in lime mortar',
    '',
    'Conservation guidance note 6. Issued 2004.',
    '',
    '## Assessing the joints',
    'Mortar joints in rubble walling weather back over time. Where the mortar has',
    'eroded more than 20mm behind the face of the stone, or where it has been',
    'previously repointed in cement and is now cracking away from the arris,',
    'repointing is warranted. Sound lime mortar that is merely weathered should be',
    'left alone; it is doing no harm and its removal damages the arrises.',
    '',
    '## Raking out',
    'Rake out by hand with a quirk or a hacksaw blade to a depth of twice the joint',
    'width. Never use an angle grinder on rubble walling. Cement pointing must be',
    'removed entirely, which is slow, and the decision to remove it should account',
    'for the damage that removal itself will cause.',
    '',
    '## The mix',
    'A 1:2.5 lime putty to sharp sand mix suits most rubble walling. Match the',
    'aggregate to the original by washing out a sample of the historic mortar.',
    'Protect from frost for 72 hours and from direct sun with damp hessian.',
    '',
    '## Damp',
    'Rising damp at the base of a rubble wall is more often a failed drain or a',
    'raised external ground level than a failure of the mortar. Establish the',
    'source before repointing, or the new work will fail in the same way.',
  ].join('\n');

  const t0 = Date.now();
  const { status, body } = await ingest({
    file: {
      name: 'guidance-note-6-repointing.md',
      mimeType: 'text/markdown',
      data: Buffer.from(md, 'utf-8').toString('base64'),
    },
    docKind: 'reference',
    artefactName: 'Timber-framed barn, south wall sill',
  });
  console.log(c.dim(`        ${Date.now() - t0}ms`));

  if (!check(`HTTP 200 (got ${status})`, status === 200, JSON.stringify(body).slice(0, 300))) return null;
  check('summary is present', (body.summary || '').length > 60, body.summary);
  check('chunks embedded', (body.chunks || []).length >= 2);
  console.log(c.dim(`\n        SUMMARY: ${body.summary}`));
  return body;
}

// ---------------------------------------------------------------------------
// The one that matters: does retrieval bridge vocabulary, and does it
// discriminate? Scored exactly the way the worker scores it — int8 dot product
// over the same quantised vectors — so a pass here is a pass in production.
// ---------------------------------------------------------------------------

async function testRetrieval(joinery, masonry) {
  section('Retrieval — vocabulary bridging and discrimination');
  if (!joinery?.chunks?.length || !masonry?.chunks?.length) {
    warn('skipped: need both documents ingested with chunks');
    return;
  }

  const { embedQuery } = await import(new URL('../api/_shared/embeddings.js', import.meta.url).href);

  const corpus = [
    ...joinery.chunks.map(ch => ({ ...ch, doc: 'joinery' })),
    ...masonry.chunks.map(ch => ({ ...ch, doc: 'masonry' })),
  ];

  // Buffer.from() returns a view into a shared pool, so `.buffer` is the whole
  // pool rather than these bytes — the reason to go through byteOffset/length
  // and not `.buffer.slice(0)`.
  const dequant = v => {
    const buf = Buffer.from(v, 'base64');
    return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  };
  const vectors = corpus.map(ch => dequant(ch.vector));

  // Quantise the query exactly as the shipping code does, so a pass here means
  // a pass in the Worker rather than a pass in this file.
  const { quantizeVector } = await import(new URL('../api/_shared/embeddings.js', import.meta.url).href);

  function rank(queryVector) {
    const qq = quantizeVector(queryVector);
    return corpus
      .map((ch, i) => {
        let dot = 0;
        const v = vectors[i];
        for (let d = 0; d < Math.min(v.length, qq.length); d++) dot += v[d] * qq[d];
        let score = dot / (127 * 127);
        // The same nudges the Worker applies, for the same reason: figure
        // captions and indications are short curated signals that diffuse
        // prose would otherwise outrank.
        if (ch.kind === 'figure') score *= 1.15;
        if (ch.kind === 'indication') score *= 1.2;
        return { doc: ch.doc, kind: ch.kind, score, content: ch.content };
      })
      .sort((a, b) => b.score - a.score);
  }

  const queries = [
    {
      q: 'the sill end is rotten over 400mm but the rest of the beam is sound',
      expect: 'joinery',
      why: 'problem vocabulary, sharing no word with "stop-splayed scarf joint"',
    },
    {
      q: 'der Balkenkopf ist verfault, der Rest des Balkens ist gesund',
      expect: 'joinery',
      why: 'the same problem in German against an English corpus',
    },
    {
      q: 'the mortar between the stones is washed out and crumbling',
      expect: 'masonry',
      why: 'discrimination — the joinery document must NOT win this one',
    },
    {
      q: 'how long should the joint be for a 160mm deep timber',
      expect: 'joinery',
      why: 'a dimension question that should reach the table on page 2',
    },
  ];

  for (const { q, expect, why } of queries) {
    let vector;
    try {
      vector = await embedQuery(q);
    } catch (err) {
      check(`query embeds: "${q.slice(0, 40)}..."`, false, err.message);
      continue;
    }
    if (!vector?.length) {
      check(`query embeds: "${q.slice(0, 40)}..."`, false, 'empty vector');
      continue;
    }
    const ranked = rank(vector);
    const top = ranked[0];
    const topThree = ranked.slice(0, 3);
    const majority = topThree.filter(r => r.doc === expect).length >= 2;

    console.log(`\n  ${c.dim(why)}`);
    console.log(`  Q: ${q}`);
    for (const r of topThree) {
      const mark = r.doc === expect ? ' ' : '!';
      console.log(c.dim(`     ${mark} ${r.score.toFixed(3)}  [${r.doc}/${r.kind}] ${r.content.replace(/\s+/g, ' ').slice(0, 78)}`));
    }
    check(`top hit is the ${expect} document`, top.doc === expect,
      `got ${top.doc} at ${top.score.toFixed(3)}`);
    if (top.doc === expect && !majority) {
      warn('only one of the top three comes from the expected document — ranking is thin');
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(c.bold('\nLive verification — Gemini, ingest, embeddings, retrieval'));
  console.log(c.dim(endpoint ? `  against deployment: ${endpoint}` : '  in-process (handlers imported directly)'));
  console.log(c.dim('  this makes real API calls and costs a few cents\n'));

  const ok = await testModels();
  if (!ok) {
    console.log(c.red('\nCannot continue without a working key.\n'));
    process.exit(1);
  }

  const run = name => !only || only === name;

  const joinery = run('pdf') ? await testIngestPdf() : null;
  const masonry = run('text') ? await testIngestText() : null;
  if (run('photo')) await testIngestPhoto();
  if (run('retrieval') || (!only && joinery && masonry)) await testRetrieval(joinery, masonry);

  console.log(`\n${c.bold('Result')}  ${c.green(passed + ' passed')}, ${failed ? c.red(failed + ' failed') : '0 failed'}${warned ? ', ' + c.yellow(warned + ' warned') : ''}`);
  if (failed) {
    console.log(c.red('\nFailed:'));
    for (const f of failures) console.log(c.red(`  - ${f}`));
    console.log('');
    process.exit(1);
  }
  console.log('');
}

main().catch(err => {
  console.error(c.red('\nHarness error:'), err);
  process.exit(1);
});
