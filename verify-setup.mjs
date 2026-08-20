#!/usr/bin/env node
/**
 * Checks that the repo is laid out correctly.
 * Run with: node verify-setup.mjs
 *
 * The prompt check is derived from the code rather than hardcoded. The old
 * version named two prompt files by hand and drifted: four endpoints loaded
 * prompts nobody was checking for, so a missing .md would only surface as a
 * 500 in production. Here we scan api/ for every `loadPrompt('x')` call and
 * require the matching src/ai/prompts/x.md to exist — a check that cannot go
 * stale because it reads the callers.
 */

import fs from 'node:fs';
import path from 'node:path';

const expected = [
  'package.json',
  'vite.config.js',
  'vercel.json',
  '.env.example',
  '.gitignore',
  'README.md',
  'src/index.html',
  'src/main.js',
  'src/core/schema.js',
  'src/core/commands.js',
  'src/core/state.js',
  'src/core/collaboration.js',
  'src/core/migrate.js',
  'src/core/photo-storage.js',
  'src/core/workspace-bundle.js',
  'src/core/image-compress.js',
  'src/views/viewer-3d.js',
  'src/views/action-graph.js',
  'src/views/spatial-graph.js',
  'src/views/radar.js',
  'src/views/entity-list.js',
  'src/views/chat-sheet.js',
  'src/views/detail-editor.js',
  'src/views/mini-viewer-3d.js',
  'src/views/execution-log.js',
  'src/styles/tokens.css',
  'src/styles/shell.css',
  'src/styles/components.css',
  'api/chat.js',
  'api/enrich-plan.js',
  'api/describe-photo.js',
  'api/synthesize-target-json.js',
  'api/modify-target-json.js',
  'api/imagine-result.js',
  'api/design-joinery.js',
  'api/_shared/gemini.js',
  'api/_shared/prompts.js',
  'api/_shared/chat-engine.js',
  'api/_shared/chat-tools.js',
  'api/_shared/workspace-read.js',
  'cloudflare/worker.js',
  'cloudflare/wrangler.jsonc',
  'cloudflare/migrations/0001_collaboration.sql',
  'tests/test-migration.mjs',
  'tests/test-commands.mjs',
  'tests/test-collaboration.mjs',
  'tests/test-gemini-config.mjs',
  'tests/test-cloudflare-api.mjs',
  'tests/test-workspace-read.mjs',
  'tests/test-state.mjs',
  'tests/test-bundle.mjs',
  'tests/fixtures/v1-repair-workspace.json',
  'docs/workflow.md',
  'docs/known-issues.md',
  'docs/cloudflare-collaboration.md',
];

// Absence is fine; these are generated or environment-specific.
const optional = [
  'src/public/examples/manifest.json',
];

let failed = 0;
console.log('\nChecking repair-workspace-v2 layout...\n');

for (const rel of expected) {
  const ok = fs.existsSync(path.resolve(rel));
  console.log(ok ? `  ✓ ${rel}` : `  ✗ MISSING: ${rel}`);
  if (!ok) failed += 1;
}

for (const rel of optional) {
  if (!fs.existsSync(path.resolve(rel))) console.log(`  · optional, not present: ${rel}`);
}

// --- prompts, derived from the endpoints that load them -------------------
console.log('\nChecking prompts referenced by api/ ...\n');

function jsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const referenced = new Map();   // prompt name -> callers
for (const file of jsFiles(path.resolve('api'))) {
  const src = fs.readFileSync(file, 'utf-8');
  for (const m of src.matchAll(/loadPrompt\(\s*['"`]([\w-]+)['"`]\s*\)/g)) {
    const rel = path.relative(process.cwd(), file);
    if (!referenced.has(m[1])) referenced.set(m[1], []);
    if (!referenced.get(m[1]).includes(rel)) referenced.get(m[1]).push(rel);
  }
}

if (!referenced.size) {
  console.log('  · no loadPrompt() calls found');
}
for (const [name, callers] of [...referenced].sort()) {
  const rel = `src/ai/prompts/${name}.md`;
  const ok = fs.existsSync(path.resolve(rel));
  console.log(ok
    ? `  ✓ ${rel}  (${callers.join(', ')})`
    : `  ✗ MISSING: ${rel}  — loaded by ${callers.join(', ')}`);
  if (!ok) failed += 1;
}

// Prompts on disk that nothing loads. Not fatal, but they rot into a
// misleading contract — the repo carried two such files for months.
const promptDir = path.resolve('src/ai/prompts');
if (fs.existsSync(promptDir)) {
  for (const f of fs.readdirSync(promptDir)) {
    if (!f.endsWith('.md')) continue;
    const name = f.replace(/\.md$/, '');
    if (!referenced.has(name)) console.log(`  · orphaned (loaded by nothing): src/ai/prompts/${f}`);
  }
}

// --- Vercel must bundle the prompt files ----------------------------------
// prompts.js reads them at runtime through a computed path, which Vercel's
// module tracer cannot follow. Without an explicit includeFiles the .md files
// may not be deployed at all, and every endpoint that loads one 500s — while
// the endpoints with inline prompts keep working, making it look like a
// partial outage rather than a packaging problem.
console.log('\nChecking Vercel prompt bundling...\n');
try {
  const vercel = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf-8'));
  const declared = JSON.stringify(vercel.functions || {});
  if (referenced.size && !declared.includes('prompts')) {
    console.log('  ✗ vercel.json declares no includeFiles covering src/ai/prompts/**');
    console.log('    Add: "functions": { "api/**/*.js": { "includeFiles": "src/ai/prompts/**" } }');
    failed += 1;
  } else {
    console.log('  ✓ prompt files are declared for the serverless bundle');
  }
} catch (err) {
  console.log(`  ✗ could not read vercel.json: ${err.message}`);
  failed += 1;
}

console.log(failed
  ? `\n✗ Layout incomplete — ${failed} problem${failed === 1 ? '' : 's'} above.\n`
  : '\n✓ Layout looks right.\n');

process.exit(failed ? 1 : 0);
