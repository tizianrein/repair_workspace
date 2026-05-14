#!/usr/bin/env node
/**
 * Checks that the repo is laid out correctly.
 * Run with: node verify-setup.mjs
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
  'src/core/migrate.js',
  'src/ai/prompts/propose.md',
  'src/ai/prompts/chat.md',
  'src/views/viewer-3d.js',
  'src/views/action-graph.js',
  'src/views/spatial-graph.js',
  'src/views/radar.js',
  'src/views/entity-list.js',
  'src/views/chat-sheet.js',
  'src/views/quick-actions.js',
  'src/views/propose-review.js',
  'src/views/justification-panel.js',
  'src/views/execution-log.js',
  'src/styles/tokens.css',
  'src/styles/shell.css',
  'src/styles/components.css',
  'src/public/examples/old-wooden-door/workspace.json',
  'api/propose.js',
  'api/chat.js',
  'api/_shared/gemini.js',
  'api/_shared/prompts.js',
  'tests/test-migration.mjs',
  'tests/test-commands.mjs',
  'tests/fixtures/v1-repair-workspace.json',
  'docs/workflow.md',
  'docs/known-issues.md',
];

let ok = true;
console.log('Checking repair-workspace-v2 layout...\n');

for (const rel of expected) {
  const abs = path.resolve(rel);
  if (fs.existsSync(abs)) {
    console.log(`  ✓ ${rel}`);
  } else {
    console.log(`  ✗ MISSING: ${rel}`);
    ok = false;
  }
}

const stray = [];
function walk(dir, depth = 0) {
  if (depth > 3) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git') || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, depth + 1); continue; }
    const rel = path.relative(process.cwd(), full).replace(/\\/g, '/');
    if (!expected.includes(rel) && !rel.includes('node_modules') && !rel.startsWith('.')
        && !rel.endsWith('package-lock.json') && rel !== 'verify-setup.mjs'
        && !rel.startsWith('tests/fixtures/v2-')) {
      stray.push(rel);
    }
  }
}
walk(process.cwd());

if (stray.length) {
  console.log('\nUnrecognized files (these might be flattened-out duplicates):');
  stray.forEach(s => console.log(`  ? ${s}`));
}

console.log('');
if (ok) console.log('✓ Layout looks correct. Now run: npm install && npm run test:migrate');
else { console.log('✗ Layout incomplete. See missing files above.'); process.exit(1); }
