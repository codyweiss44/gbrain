#!/usr/bin/env bun
/**
 * Audit wikilinks across the brain. Outputs 3 lists:
 *   1. ambiguous.jsonl   — wikilinks with multiple non-vault/vault candidates
 *   2. missing.jsonl     — wikilinks that don't match any page
 *   3. stale-dupes.jsonl — non-vault/ slugs that have a vault/ twin (safe to delete)
 *
 * Read-only — writes nothing to the DB. Designed to scope cleanup work.
 *
 * Usage: DATABASE_URL=postgres://... bun run scripts/audit-wikilinks.ts
 */
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { extractWikilinks } from '../src/core/wikilinks.ts';
import { writeFileSync } from 'fs';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('Set DATABASE_URL');
  process.exit(1);
}

const engine = new PostgresEngine();
await engine.connect({ database_url: DB_URL });

const PAGE_BATCH = 500;
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
const slugs = allPages.map((p) => p.slug);
const slugSet = new Set(slugs);

// --- 3. stale-dupes: non-vault/ slug where a vault/ twin exists ---
// A "twin" means same trailing path minus the `vault/` prefix.
// e.g. wiki/partners/scim (stale) vs vault/wiki/partners/scim (canonical)
const staleDupes: { stale: string; canonical: string }[] = [];
for (const s of slugs) {
  if (s.startsWith('vault/')) continue;
  const candidate = `vault/${s}`;
  if (slugSet.has(candidate)) {
    staleDupes.push({ stale: s, canonical: candidate });
  }
}

// --- 1 & 2. audit ambiguous + missing per page ---
const ambiguous: { from: string; target: string; candidates: string[] }[] = [];
const missing: { from: string; target: string }[] = [];

for (const page of allPages) {
  const refs = [
    ...extractWikilinks(page.compiled_truth || ''),
    ...extractWikilinks(page.timeline || ''),
  ];
  for (const ref of refs) {
    // Replicate resolveWikilinkTarget logic inline so we can capture candidates
    if (slugSet.has(ref.target)) continue; // exact match
    const needle = '/' + ref.target.toLowerCase();
    const matches = slugs.filter((s) => s.toLowerCase().endsWith(needle));
    if (matches.length === 0) {
      missing.push({ from: page.slug, target: ref.target });
      continue;
    }
    if (matches.length === 1) continue;
    const vaultMatches = matches.filter((s) => s.startsWith('vault/'));
    if (vaultMatches.length === 1) continue;
    const pool = vaultMatches.length > 0 ? vaultMatches : matches;
    // Sibling + category-order fallback (mirror resolveWikilinkTarget)
    const srcParts = page.slug.split('/');
    let resolvedBySibling = false;
    for (let depth = srcParts.length - 1; depth >= 2; depth--) {
      const prefix = srcParts.slice(0, depth).join('/') + '/';
      const sib = pool.filter((s) => s.startsWith(prefix));
      if (sib.length === 1) { resolvedBySibling = true; break; }
    }
    if (resolvedBySibling) continue;
    const CATEGORY_ORDER = ['domains', 'properties', 'partners', 'gl-patterns', 'loans'];
    let resolvedByOrder = false;
    for (const cat of CATEGORY_ORDER) {
      const hits = pool.filter((s) => s.split('/')[2] === cat);
      if (hits.length === 1) { resolvedByOrder = true; break; }
    }
    if (resolvedByOrder) continue;
    ambiguous.push({ from: page.slug, target: ref.target, candidates: matches });
  }
}

writeFileSync(
  'C:/Root/.gbrain-fork/scripts/audit-ambiguous.jsonl',
  ambiguous.map((r) => JSON.stringify(r)).join('\n') + '\n',
);
writeFileSync(
  'C:/Root/.gbrain-fork/scripts/audit-missing.jsonl',
  missing.map((r) => JSON.stringify(r)).join('\n') + '\n',
);
writeFileSync(
  'C:/Root/.gbrain-fork/scripts/audit-stale-dupes.jsonl',
  staleDupes.map((r) => JSON.stringify(r)).join('\n') + '\n',
);

console.log('');
console.log(`Ambiguous:   ${ambiguous.length}  -> audit-ambiguous.jsonl`);
console.log(`Missing:     ${missing.length}  -> audit-missing.jsonl`);
console.log(`Stale dupes: ${staleDupes.length}  -> audit-stale-dupes.jsonl`);

await engine.disconnect?.();
