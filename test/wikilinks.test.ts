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

  test('stays ambiguous when multiple vault/ hits exist', async () => {
    const engine = mockEngine([
      { slug: 'vault/wiki/properties/ATH' },
      { slug: 'vault/wiki/loans/ATH' },
    ]);
    expect(await resolveWikilinkTarget(engine, 'ATH')).toBeNull();
  });

  test('returns null when no match exists', async () => {
    const engine = mockEngine([{ slug: 'scim' }]);
    expect(await resolveWikilinkTarget(engine, 'nonexistent')).toBeNull();
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
