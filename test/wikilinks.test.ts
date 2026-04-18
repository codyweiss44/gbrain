import { describe, test, expect } from 'bun:test';
import { extractWikilinks, resolveWikilinkTarget } from '../src/core/wikilinks.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('extractWikilinks', () => {
  test('extracts a plain wikilink', () => {
    const refs = extractWikilinks('See [[ATH]] for context.');
    expect(refs).toEqual([{ target: 'ATH' }]);
  });

  test('extracts a pipe-display wikilink', () => {
    const refs = extractWikilinks('Equity partner [[scim|SCIM]].');
    expect(refs).toEqual([{ target: 'scim', display: 'SCIM' }]);
  });

  test('extracts an anchor-only wikilink', () => {
    const refs = extractWikilinks('Details in [[leasing#velocity]].');
    expect(refs).toEqual([{ target: 'leasing', anchor: 'velocity' }]);
  });

  test('extracts an anchor + display wikilink', () => {
    const refs = extractWikilinks('See [[leasing#velocity|leasing velocity]].');
    expect(refs).toEqual([
      { target: 'leasing', anchor: 'velocity', display: 'leasing velocity' },
    ]);
  });

  test('extracts path-style targets', () => {
    const refs = extractWikilinks('Cross: [[domains/insurance]] and [[properties/ATH]].');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ target: 'domains/insurance' });
    expect(refs[1]).toEqual({ target: 'properties/ATH' });
  });

  test('extracts multiple wikilinks on one line', () => {
    const refs = extractWikilinks('[[a]] then [[b|B]] and [[c#h]].');
    expect(refs).toEqual([
      { target: 'a' },
      { target: 'b', display: 'B' },
      { target: 'c', anchor: 'h' },
    ]);
  });

  test('ignores wikilinks inside inline code', () => {
    const refs = extractWikilinks('Real: [[a]]. Code: `[[b]]`. Real: [[c]].');
    expect(refs.map((r) => r.target)).toEqual(['a', 'c']);
  });

  test('ignores wikilinks inside fenced code blocks', () => {
    const body = 'Before [[a]]\n```\nfake [[b]] inside fence\n```\nAfter [[c]]';
    const refs = extractWikilinks(body);
    expect(refs.map((r) => r.target)).toEqual(['a', 'c']);
  });

  test('ignores escaped wikilinks', () => {
    const refs = extractWikilinks('Real [[a]] and escaped \\[[b]].');
    expect(refs.map((r) => r.target)).toEqual(['a']);
  });

  test('skips empty targets', () => {
    expect(extractWikilinks('nothing [[]] nothing')).toEqual([]);
    expect(extractWikilinks('[[ ]]')).toEqual([]);
  });

  test('trims whitespace in target and display', () => {
    const refs = extractWikilinks('[[  scim  |  SCIM  ]]');
    expect(refs).toEqual([{ target: 'scim', display: 'SCIM' }]);
  });

  test('dedupes repeated identical references', () => {
    const refs = extractWikilinks('[[a]] then [[a]] again, plus [[a|different]] display');
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe('a');
  });

  test('handles empty string', () => {
    expect(extractWikilinks('')).toEqual([]);
  });

  test('ignores cross-line matches', () => {
    const refs = extractWikilinks('[[foo\nbar]]');
    expect(refs).toEqual([]);
  });

  test('strips trailing backslash from target (markdown table pipe escape)', () => {
    // Inside a markdown table: [[slug\|display]] is the only way to write a
    // wikilink with display text without the bare | breaking the table cell.
    const refs = extractWikilinks('| [[loans/ATH\\|Rambler Athens]] | $133M |');
    expect(refs).toEqual([{ target: 'loans/ATH', display: 'Rambler Athens' }]);
  });
});

describe('resolveWikilinkTarget', () => {
  function mockEngine(pages: { slug: string }[]): BrainEngine {
    return {
      getPage: async (slug: string) => {
        const p = pages.find((x) => x.slug === slug);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (p ? (p as any) : null);
      },
      listPages: async () => pages as unknown as import('../src/core/types.ts').Page[],
      // Unused methods for these tests
    } as unknown as BrainEngine;
  }

  test('resolves exact match', async () => {
    const engine = mockEngine([{ slug: 'scim' }, { slug: 'properties/ATH' }]);
    expect(await resolveWikilinkTarget(engine, 'scim')).toBe('scim');
  });

  test('resolves unique suffix match (case-insensitive)', async () => {
    const engine = mockEngine([
      { slug: 'properties/ATH' },
      { slug: 'domains/insurance' },
    ]);
    expect(await resolveWikilinkTarget(engine, 'ATH')).toBe('properties/ATH');
    expect(await resolveWikilinkTarget(engine, 'ath')).toBe('properties/ATH');
  });

  test('returns null on ambiguous suffix', async () => {
    const engine = mockEngine([
      { slug: 'properties/ATH' },
      { slug: 'loans/ATH' },
    ]);
    expect(await resolveWikilinkTarget(engine, 'ATH')).toBeNull();
  });

  test('prefers vault/-prefixed slug when duplicated at vault/ and non-vault/', async () => {
    const engine = mockEngine([
      { slug: 'wiki/partners/scim' },
      { slug: 'vault/wiki/partners/scim' },
    ]);
    expect(await resolveWikilinkTarget(engine, 'scim')).toBe('vault/wiki/partners/scim');
  });

  test('stays ambiguous when multiple vault/ hits exist in same category', async () => {
    // Same category (both under properties/) with no category-order fallback hit.
    const engine = mockEngine([
      { slug: 'vault/wiki/properties/athens' },
      { slug: 'vault/wiki/properties/atlanta' },
    ]);
    expect(await resolveWikilinkTarget(engine, 'athens', ['vault/wiki/properties/athens', 'vault/wiki/properties/atlanta'])).toBe('vault/wiki/properties/athens');
    // But unique-suffix resolves the above. Genuine same-category ambiguity:
    const engine2 = mockEngine([
      { slug: 'vault/deals/value-add-acquisitions/lmk/budget' },
      { slug: 'vault/deals/value-add-acquisitions/hts/budget' },
    ]);
    const slugs2 = ['vault/deals/value-add-acquisitions/lmk/budget', 'vault/deals/value-add-acquisitions/hts/budget'];
    expect(await resolveWikilinkTarget(engine2, 'budget', slugs2)).toBeNull();
  });

  test('returns null when no match exists', async () => {
    const engine = mockEngine([{ slug: 'scim' }]);
    expect(await resolveWikilinkTarget(engine, 'nonexistent')).toBeNull();
  });

  test('sibling-match: source in loans/ prefers loans candidate', async () => {
    const engine = mockEngine([
      { slug: 'vault/wiki/properties/ath' },
      { slug: 'vault/wiki/loans/ath' },
    ]);
    const slugs = ['vault/wiki/properties/ath', 'vault/wiki/loans/ath'];
    expect(await resolveWikilinkTarget(engine, 'ATH', slugs, 'vault/wiki/loans/portfolio-summary'))
      .toBe('vault/wiki/loans/ath');
  });

  test('sibling-match: source in properties/ prefers properties candidate', async () => {
    const engine = mockEngine([
      { slug: 'vault/wiki/properties/ath' },
      { slug: 'vault/wiki/loans/ath' },
    ]);
    const slugs = ['vault/wiki/properties/ath', 'vault/wiki/loans/ath'];
    expect(await resolveWikilinkTarget(engine, 'ATH', slugs, 'vault/wiki/properties/sw'))
      .toBe('vault/wiki/properties/ath');
  });

  test('category-order fallback: bare [[ATH]] from gl-patterns -> properties', async () => {
    const engine = mockEngine([
      { slug: 'vault/wiki/properties/ath' },
      { slug: 'vault/wiki/loans/ath' },
    ]);
    const slugs = ['vault/wiki/properties/ath', 'vault/wiki/loans/ath'];
    expect(await resolveWikilinkTarget(engine, 'ATH', slugs, 'vault/wiki/gl-patterns/utilities'))
      .toBe('vault/wiki/properties/ath');
  });

  test('category-order fallback: bare [[insurance]] prefers domains over gl-patterns', async () => {
    const engine = mockEngine([
      { slug: 'vault/wiki/domains/insurance' },
      { slug: 'vault/wiki/gl-patterns/insurance' },
    ]);
    const slugs = ['vault/wiki/domains/insurance', 'vault/wiki/gl-patterns/insurance'];
    expect(await resolveWikilinkTarget(engine, 'insurance', slugs, 'vault/wiki/properties/sw'))
      .toBe('vault/wiki/domains/insurance');
  });

  test('uses provided slug index without calling listPages', async () => {
    let listCalls = 0;
    const engine = {
      getPage: async () => null,
      listPages: async () => {
        listCalls++;
        return [];
      },
    } as unknown as BrainEngine;
    const slugs = ['properties/ATH', 'domains/insurance'];
    expect(await resolveWikilinkTarget(engine, 'ATH', slugs)).toBe('properties/ATH');
    expect(listCalls).toBe(0);
  });
});
