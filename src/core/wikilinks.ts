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
    const target = match[1].trim();
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
 */
export async function resolveWikilinkTarget(
  engine: BrainEngine,
  target: string,
  slugIndex?: string[],
): Promise<string | null> {
  const exact = await engine.getPage(target);
  if (exact) return exact.slug;

  const slugs = slugIndex ?? (await engine.listPages()).map((p) => p.slug);
  const needle = '/' + target.toLowerCase();
  const matches = slugs.filter((s) => s.toLowerCase().endsWith(needle));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const vaultMatches = matches.filter((s) => s.startsWith('vault/'));
    if (vaultMatches.length === 1) return vaultMatches[0];
  }
  return null;
}
