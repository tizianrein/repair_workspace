#!/usr/bin/env node
/**
 * Run the whole stack for local development.
 *
 * Repair Workspace is three processes, not one, and each owns a different part
 * of the app:
 *
 *   vite      :5173   the frontend, and the proxy that ties the other two in
 *   vercel    :3000   /api/* — the Gemini endpoints (chat, ingest, imagine)
 *   wrangler  :8787   /api/collaboration/* — projects, layers, corpus (D1 + R2)
 *
 * vite.config.js proxies /api/collaboration to 8787 and everything else under
 * /api to 3000, so the browser only ever talks to 5173 and the split is
 * invisible from the app's point of view.
 *
 * Each process is optional in the sense that the app degrades rather than
 * breaks: without wrangler you work locally with no sync, without vercel the
 * AI features fail but everything else works. This script starts all three and
 * prefixes their output so it is clear which one is complaining.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const isWindows = process.platform === 'win32';

/**
 * Load .env.local into this process before starting anything.
 *
 * `vercel dev` on a LINKED project retrieves the project's environment from
 * Vercel, and that takes precedence — so if GEMINI_API_KEY is not set in the
 * Vercel project, the local functions get no key no matter what .env.local
 * says, and every AI call fails with "GEMINI_API_KEY not configured on the
 * server". The failure names the key, which sends you looking at .env.local,
 * which is correct, which is why this wastes ten minutes.
 *
 * Putting the values in the environment we spawn from settles it: an inherited
 * variable is there whichever way the CLI resolves things.
 */
function loadEnvLocal() {
  if (!existsSync('.env.local')) return [];
  const loaded = [];
  for (const raw of readFileSync('.env.local', 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Never override something the caller set deliberately.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

const loadedEnv = loadEnvLocal();

const SERVICES = [
  {
    name: 'vite',
    color: '\x1b[36m',
    command: 'npm',
    args: ['run', 'dev'],
    note: 'http://localhost:5173  ← open this',
  },
  {
    name: 'worker',
    color: '\x1b[35m',
    command: 'npm',
    args: ['run', 'cloudflare:dev'],
    note: 'collaboration API on :8787 (local D1 + R2)',
  },
  {
    name: 'api',
    color: '\x1b[33m',
    command: 'vercel',
    args: ['dev', '--listen', '3000'],
    note: 'Gemini endpoints on :3000 — needs the Vercel CLI and GEMINI_API_KEY',
    optional: true,
  },
];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const children = [];

function prefix(service, chunk) {
  const text = chunk.toString();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    process.stdout.write(`${service.color}${service.name.padEnd(7)}${RESET} ${DIM}│${RESET} ${line}\n`);
  }
}

console.log('\nStarting the Repair Workspace stack:\n');
for (const s of SERVICES) {
  console.log(`  ${s.color}${s.name.padEnd(7)}${RESET} ${s.note}`);
}
console.log(`\n${DIM}Ctrl+C stops all three.${RESET}`);
console.log(loadedEnv.length
  ? `${DIM}Loaded from .env.local: ${loadedEnv.join(', ')}${RESET}\n`
  : `${DIM}Nothing loaded from .env.local — AI endpoints fail unless the key is already in your environment.${RESET}\n`);

for (const service of SERVICES) {
  const child = spawn(service.command, service.args, {
    // Windows resolves npm/vercel through .cmd shims, which need a shell.
    shell: isWindows,
    env: process.env,
  });

  child.stdout.on('data', chunk => prefix(service, chunk));
  child.stderr.on('data', chunk => prefix(service, chunk));

  child.on('error', err => {
    if (service.optional) {
      console.log(
        `${service.color}${service.name.padEnd(7)}${RESET} ${DIM}│${RESET} not started (${err.message}). ` +
        `AI features will not work; everything else will.`,
      );
      return;
    }
    console.error(`\n${service.name} failed to start: ${err.message}\n`);
  });

  child.on('exit', code => {
    if (code !== 0 && code !== null) {
      console.log(`${service.color}${service.name.padEnd(7)}${RESET} ${DIM}│${RESET} exited with code ${code}`);
    }
  });

  children.push(child);
}

function shutdown() {
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
