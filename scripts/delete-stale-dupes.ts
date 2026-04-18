#!/usr/bin/env bun
/**
 * Delete non-vault/ slugs that have a byte-identical vault/ twin.
 *
 * Safety: reads audit-stale-dupes.jsonl and re-verifies each pair is still
 * byte-identical before deleting. If any diverged since the audit ran, it's
 * skipped and logged.
 *
 * Usage:
 *   DATABASE_URL=... bun run scripts/delete-stale-dupes.ts [--dry-run]
 */
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('Set DATABASE_URL');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');

const engine = new PostgresEngine();
await engine.connect({ database_url: DB_URL });

const lines = readFileSync(
  'C:/Root/.gbrain-fork/scripts/audit-stale-dupes.jsonl',
  'utf-8',
).trim().split('\n');
const dupes = lines.map((l) => JSON.parse(l)) as { stale: string; canonical: string }[];

console.log(`\nDeleting ${dupes.length} stale dupes${dryRun ? ' (DRY RUN)' : ''}\n`);

let deleted = 0;
let skippedDivergence = 0;
let skippedMissing = 0;
let errors = 0;

for (const { stale, canonical } of dupes) {
  const a = await engine.getPage(stale);
  const b = await engine.getPage(canonical);
  if (!a) { skippedMissing++; continue; }
  if (!b) {
    skippedMissing++;
    console.warn(`[skip] canonical ${canonical} not found; preserving ${stale}`);
    continue;
  }
  const ah = createHash('sha256').update((a.compiled_truth||'') + (a.timeline||'')).digest('hex');
  const bh = createHash('sha256').update((b.compiled_truth||'') + (b.timeline||'')).digest('hex');
  if (ah !== bh) {
    skippedDivergence++;
    console.warn(`[skip] ${stale} diverged from ${canonical}; preserving`);
    continue;
  }
  if (dryRun) { deleted++; continue; }
  try {
    await engine.deletePage(stale);
    deleted++;
  } catch (e) {
    errors++;
    console.warn(`[err] delete ${stale}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('');
console.log(`Deleted:             ${deleted}`);
console.log(`Skipped (diverged):  ${skippedDivergence}`);
console.log(`Skipped (missing):   ${skippedMissing}`);
console.log(`Errors:              ${errors}`);

await engine.disconnect?.();
