#!/usr/bin/env bun
/**
 * Backfill wikilinks for all existing pages.
 *
 * Runs reconcileWikilinks page-by-page against the configured engine. Safe to
 * re-run: addLink upserts on (from, to), and the reconcile path only touches
 * link_type='wikilink' rows, so explicit agent-added links are untouched.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun run scripts/backfill-wikilinks.ts
 *   DATABASE_URL=postgres://... bun run scripts/backfill-wikilinks.ts --dry-run
 */
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { reconcileWikilinks } from '../src/core/import-file.ts';
import { extractWikilinks, resolveWikilinkTarget } from '../src/core/wikilinks.ts';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('Set DATABASE_URL');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const PAGE_BATCH = 500;

const engine = new PostgresEngine();
await engine.connect({ database_url: DB_URL });

console.log(`\nBackfill wikilinks${dryRun ? ' (DRY RUN)' : ''}\n`);

// Fetch every page in pages of PAGE_BATCH.
const allPages = [];
let offset = 0;
while (true) {
  const page = await engine.listPages({ limit: PAGE_BATCH, offset });
  if (!page || page.length === 0) break;
  allPages.push(...page);
  if (page.length < PAGE_BATCH) break;
  offset += PAGE_BATCH;
}

console.log(`Loaded ${allPages.length} pages.`);
const slugIndex = allPages.map((p) => p.slug);

let pagesWithLinks = 0;
let totalResolved = 0;
let totalAmbiguous = 0;
let totalSelf = 0;
let totalMissing = 0;
let errors = 0;

for (const page of allPages) {
  const refs = [
    ...extractWikilinks(page.compiled_truth || ''),
    ...extractWikilinks(page.timeline || ''),
  ];
  if (refs.length === 0) continue;
  pagesWithLinks++;

  let resolvedCount = 0;
  for (const ref of refs) {
    const resolved = await resolveWikilinkTarget(engine, ref.target, slugIndex);
    if (resolved === page.slug) {
      totalSelf++;
      continue;
    }
    if (!resolved) {
      // Distinguish ambiguous from missing by re-checking suffix hits.
      const needle = '/' + ref.target.toLowerCase();
      const hits = slugIndex.filter((s) => s.toLowerCase().endsWith(needle));
      const exactMiss = !slugIndex.includes(ref.target);
      if (hits.length > 1) totalAmbiguous++;
      else if (exactMiss) totalMissing++;
      continue;
    }
    resolvedCount++;
    totalResolved++;
  }

  if (!dryRun && resolvedCount > 0) {
    try {
      await reconcileWikilinks(
        engine,
        page.slug,
        page.compiled_truth || '',
        page.timeline || '',
        slugIndex,
      );
    } catch (e) {
      errors++;
      console.warn(
        `[backfill] reconcile failed for ${page.slug}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

console.log('');
console.log(`Pages scanned:               ${allPages.length}`);
console.log(`Pages with wikilinks:        ${pagesWithLinks}`);
console.log(`Wikilinks resolved:          ${totalResolved}`);
console.log(`Wikilinks ambiguous (skip):  ${totalAmbiguous}`);
console.log(`Wikilinks missing (skip):    ${totalMissing}`);
console.log(`Wikilinks self (skip):       ${totalSelf}`);
console.log(`Reconcile errors:            ${errors}`);
if (dryRun) console.log('\nDry run: no links written.');
else console.log('\nBackfill complete.');

await engine.disconnect?.();
