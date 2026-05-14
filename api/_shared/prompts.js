/**
 * Prompt loader.
 *
 * Reads prompt .md files from src/ai/prompts/ at request time. Cached in
 * memory after first read. This is the seam that lets us version-control,
 * diff, and A/B test prompts without code changes.
 *
 * In Vercel's serverless functions the working dir is the project root.
 */

import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();
const PROMPTS_DIR = path.join(process.cwd(), 'src', 'ai', 'prompts');

export function loadPrompt(name) {
  if (cache.has(name)) return cache.get(name);
  const p = path.join(PROMPTS_DIR, `${name}.md`);
  if (!fs.existsSync(p)) throw new Error(`Prompt file not found: ${p}`);
  const content = fs.readFileSync(p, 'utf-8');
  cache.set(name, content);
  return content;
}
