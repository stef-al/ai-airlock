import { describe, expect, it } from 'vitest';
import { analyze, mask, Mapping, restoreText } from '../src/engine';
import { fixtureSettings, loadFixtures } from './harness';

const fixtures = loadFixtures();

describe('corpus', () => {
  it('has fixtures with expected spans', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(25);
    for (const f of fixtures) for (const s of f.spans) expect(f.text.slice(s.start, s.end)).toBe(s.text);
  });

  for (const f of fixtures) {
    it(`${f.id}: structure guard passes and mask → restore is byte-identical`, () => {
      const settings = fixtureSettings(f);
      const mapping = new Mapping();
      const a = analyze(f.text, settings, { fileName: f.fileName, format: (f.format as never) ?? 'auto' });
      const m = mask(a.doc, a.hits, mapping, settings);
      expect(m.guard.issues.filter((i) => !i.startsWith('skipped'))).toEqual([]);
      expect(m.guard.ok).toBe(true);
      expect(m.skipped.length).toBe(0);
      const back = restoreText(m.output, mapping);
      expect(back.output).toBe(f.text);
      // a second paste of the same text in the same session reuses the same placeholders
      const a2 = analyze(f.text, settings, { fileName: f.fileName, format: (f.format as never) ?? 'auto' });
      const m2 = mask(a2.doc, a2.hits, mapping, settings);
      expect(m2.output).toBe(m.output);
    });
  }

  it('traps fixture produces no hits', () => {
    const f = fixtures.find((x) => x.id === 'd-traps')!;
    const a = analyze(f.text, fixtureSettings(f), { format: 'prose' });
    expect(a.hits.map((h) => `${h.type}:${f.text.slice(h.start, h.end)}`)).toEqual([]);
  });
});
