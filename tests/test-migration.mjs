/**
 * Run from project root:
 *   node tests/test-migration.mjs
 *
 * Reads the v1 example, migrates it, validates it, prints a summary plus any
 * warnings. Fails loudly if validation fails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateV1ToV2 } from '../src/core/migrate.js';
import { validateWorkspace } from '../src/core/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const v1Path = path.join(__dirname, 'fixtures', 'v1-repair-workspace.json');

const v1 = JSON.parse(fs.readFileSync(v1Path, 'utf-8'));
const { workspace, warnings } = migrateV1ToV2(v1);
const validation = validateWorkspace(workspace);

console.log('=== MIGRATION SUMMARY ===');
console.log(`Instance: ${workspace.instance.name}`);
console.log(`Parts:    ${workspace.instance.parts.length}`);
console.log(`Conditions: ${workspace.conditions.length}`);
console.log(`Plans:    ${workspace.plans.length} (current: ${workspace.currentPlanId})`);
if (workspace.plans.length) {
  workspace.plans.forEach((p, i) => {
    console.log(`  Plan ${i + 1}: "${p.label}" — ${p.steps.length} steps, ${p.edges.length} edges`);
  });
}
console.log(`Intent axes: ${workspace.intent.axes.length}`);

if (warnings.length) {
  console.log('\n=== WARNINGS ===');
  warnings.forEach(w => console.log(`  • ${w}`));
}

if (!validation.ok) {
  console.error('\n=== VALIDATION FAILED ===');
  validation.errors.forEach(e => console.error(`  ✗ ${e}`));
  process.exit(1);
} else {
  console.log('\n✓ Validation passed');
}

const outPath = path.join(__dirname, 'fixtures', 'v2-migrated-workspace.json');
fs.writeFileSync(outPath, JSON.stringify(workspace, null, 2));
console.log(`\nMigrated workspace written to ${path.relative(process.cwd(), outPath)}`);
