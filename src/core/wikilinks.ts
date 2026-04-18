/**
 * Wikilink extraction and resolution.
 *
 * Fork-specific addition: upstream gbrain requires agents to call `add_link`
 * explicitly, but this fork's vault uses Obsidian-style `[[wikilinks]]` heavily.
 * We extract and resolve them mechanically during ingestion so the `links`
 * table reflects the actual graph implied by page bodies.
 *
 * Supported patterns:
 *   [[slug]]                      plain
 *   [[slug|display text]]         with display
 *   [[slug#anchor]]               with header anchor (anchor → context)
 *   [[slug#anchor|display]]       combined
 *   [[folder/sub/slug]]           path-style
 *
 * Ignored:
 *   wrapped in `inline code` or ```fenced blocks```
 *   \[[escaped]]                  backslash-escaped
 *   [[]]                          empty target
 *
 * Resolution is deliberately stricter than `resolveSlugs` (which uses pg_trgm
 * and can match surprising things like `[[ATH]]` → any slug containing "ATH").
 * Strategy:
 *   1. Exact slug match.
 *   2. Unique case-insensitive suffix match, e.g. `[[ATH]]` → `properties/ATH`.
 *   3. If multiple suffix hits exist, prefer `vault/`-prefixed slugs. This
 *      handles a vault-specific migration artifact where `wiki/x` and
 *      `vault/wiki/x` both exist pointing at the same content (see CLAUDE.md
 *      "Migration Map"). Without this preference, ~65% of bare wikilinks like
 *      `[[SCIM]]` would resolve as "ambiguous" when they're really just duplicated.
 *   4. Still ambiguous or missing → null (caller skips rather than guesses).
 */

import type { BrainEngine } from './engine.ts';

export interface WikilinkRef {
  target: string;
  display?: string;
  anchor?: string;
}

const WIKILINK_RE =
  /(?<!\\)\[\[([^\[\]|#\n]+)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g;

const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * Extract wikilinks from body text. Code regions are masked with whitespace of
 * equal length before extraction so wikilinks written inside code blocks don't
 * leak into the graph.
 */
export function extractWikilinks(text: string): WikilinkRef[] {
  if (!text) return [];
  const masked = text.replace(CODE_RE, (m) => ' '.repeat(m.length));
  const refs: WikilinkRef[] = [];
  const seen = new Set<string>();
  for (const match of masked.matchAll(WIKILINK_RE)) {
    // Strip trailing backslash: inside markdown tables, authors escape the
    // pipe as `[[slug\|display]]` so the bare `|` doesn't terminate the table
    // cell. Our regex stops at `|` in the target group, leaving the `\` glued
    // onto the slug. No real slug ends in `\`, so trimming is safe.
    const target = match[1].trim().replace(/\\$/, '');
    if (!target) continue;
    const anchor = match[2]?.trim();
    const display = match[3]?.trim();
    const key = `${target}#${anchor ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      target,
      ...(anchor ? { anchor } : {}),
      ...(display ? { display } : {}),
    });
  }
  return refs;
}

/**
 * Resolve a wikilink target to a concrete page slug, or null if ambiguous/missing.
 * `slugIndex` is an optional cached slug list to avoid a listPages() per call
 * during bulk operations (see importFromContent and the backfill script).
 *
 * `sourceSlug` is the slug of the page the wikilink lives on. When multiple
 * vault/ candidates remain after the vault-prefix filter, we prefer a candidate
 * that shares the source's second-level folder (e.g. `vault/wiki/loans/*`). This
 * disambiguates bare `[[ATH]]` in loan docs (→ `loans/ATH`) vs in property/domain
 * docs (→ `properties/ATH`) mechanically, without requiring every author to
 * path-qualify. Still ambiguous after sibling-match → null.
 */
export async function resolveWikilinkTarget(
  engine: BrainEngine,
  target: string,
  slugIndex?: string[],
  sourceSlug?: string,
): Promise<string | null> {
  const exact = await engine.getPage(target);
  if (exact) return exact.slug;

  const slugs = slugIndex ?? (await engine.listPages()).map((p) => p.slug);
  const needle = '/' + target.toLowerCase();
  const matches = slugs.filter((s) => s.toLowerCase().endsWith(needle));
  if (matches.length === 1) return matches[0];
  if (matches.length <= 1) return null;

  const vaultMatches = matches.filter((s) => s.startsWith('vault/'));
  if (vaultMatches.length === 1) return vaultMatches[0];
  const pool = vaultMatches.length > 0 ? vaultMatches : matches;

  // Sibling rule: a wikilink inside `vault/wiki/loans/*` almost always means
  // the loan twin, not the property entity. Preference walks by path-prefix
  // depth: try longest shared prefix with source first, then shorter. So a
  // wikilink on `vault/deals/value-add-acquisitions/hts/pay-apps` prefers
  // `.../hts/budget` over `.../lmk/budget`, then falls back to 3rd-segment
  // (`deals/` vs `wiki/`) if nothing deeper resolves uniquely.
  if (sourceSlug) {
    const sourceParts = sourceSlug.split('/');
    for (let depth = sourceParts.length - 1; depth >= 2; depth--) {
      const prefix = sourceParts.slice(0, depth).join('/') + '/';
      const siblingMatches = pool.filter((s) => s.startsWith(prefix));
      if (siblingMatches.length === 1) return siblingMatches[0];
    }
  }

  // Fallback preference when no sibling: domain concepts win over property
  // entities win over partner/pattern/loan docs. Encodes "bare `[[insurance]]`
  // from a property page means the insurance domain, not the GL pattern" and
  // "bare `[[ATH]]` from a domain/gl-pattern/partner page means the property
  // entity, not the loan doc".
  const CATEGORY_ORDER = ['domains', 'properties', 'partners', 'gl-patterns', 'loans'];
  for (const cat of CATEGORY_ORDER) {
    const hits = pool.filter((s) => s.split('/')[2] === cat);
    if (hits.length === 1) return hits[0];
  }

  return null;
}
