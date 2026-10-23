import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allDetectors, analyze, defaultSettings, mergeSettings, type Hit, type Settings } from '../src/engine';
import { CAT_OF_TYPE } from '../src/engine/detectors/helpers';
import { expandMacros } from './tokens';

export interface Span {
  start: number;
  end: number;
  type: string;
  text: string;
}
export interface Fixture {
  name: string;
  id: string;
  fileName?: string;
  set: 'dev' | 'holdout';
  settings: Partial<Settings> & { region?: string };
  format?: string;
  text: string;
  spans: Span[];
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'corpus');

/** Types whose detectors arrive with Tier 2; they are ignored by the metrics until then. */
const TIER2_TYPES = new Set(['PERSON', 'ORG', 'IP', 'IPV6', 'MAC', 'HOST', 'USERNAME', 'DOB', 'SSN', 'NATIONAL_ID']);

export function tier2Active(): boolean {
  return allDetectors().some((d) => d.id === 'names.person');
}

export function parseFixture(id: string, raw: string): Fixture {
  const sep = raw.indexOf('\n#!---\n');
  if (sep < 0) throw new Error(`fixture ${id}: missing #!--- separator`);
  const head = raw.slice(0, sep).split('\n');
  const body = expandMacros(raw.slice(sep + 7));
  const meta: Record<string, string> = {};
  for (const l of head) {
    const m = /^#!\s*(\w+):\s*(.*)$/.exec(l);
    if (m) meta[m[1]] = m[2];
  }
  let text = '';
  const spans: Span[] = [];
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('⟦', i);
    if (open < 0) {
      text += body.slice(i);
      break;
    }
    text += body.slice(i, open);
    const colon = body.indexOf(':', open);
    const close = body.indexOf('⟧', open);
    if (colon < 0 || close < 0 || colon > close) throw new Error(`fixture ${id}: bad marker at ${open}`);
    const type = body.slice(open + 1, colon);
    const inner = body.slice(colon + 1, close);
    spans.push({ start: text.length, end: text.length + inner.length, type, text: inner });
    text += inner;
    i = close + 1;
  }
  return {
    name: meta.name ?? id,
    id,
    fileName: meta.file,
    set: meta.set === 'holdout' ? 'holdout' : 'dev',
    settings: meta.settings ? JSON.parse(meta.settings) : {},
    format: meta.format,
    text,
    spans,
  };
}

export function loadFixtures(): Fixture[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.fixture'))
    .sort()
    .map((f) => parseFixture(f.replace(/\.fixture$/, ''), readFileSync(join(DIR, f), 'utf8')));
}

export function fixtureSettings(f: Fixture): Settings {
  const { region, ...rest } = f.settings;
  return mergeSettings(defaultSettings(region ?? 'US'), rest as Partial<Settings>);
}

/** `sniff`: ignore the fixture's file name and format, as when text is pasted without a file. */
export function analyzeFixture(f: Fixture, sniff = false) {
  if (sniff) return analyze(f.text, fixtureSettings(f), { format: 'auto' });
  return analyze(f.text, fixtureSettings(f), { fileName: f.fileName, format: (f.format as never) ?? 'auto' });
}

const catOf = (type: string) => CAT_OF_TYPE[type] ?? 'custom';
const iou = (a: { start: number; end: number }, b: { start: number; end: number }) => {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union ? inter / union : 0;
};

export interface Counts {
  expected: number;
  hits: number;
  tp: number;
  fp: number;
  fn: number;
  exact: number;
}
const zero = (): Counts => ({ expected: 0, hits: 0, tp: 0, fp: 0, fn: 0, exact: 0 });

export interface Detail {
  fixture: string;
  kind: 'FN' | 'FP';
  type: string;
  text: string;
  detector?: string;
  reason?: string;
  line: number;
}

export interface Evaluation {
  byCategory: Record<string, Counts>;
  byDetector: Record<string, Counts>;
  byType: Record<string, Counts>;
  total: Counts;
  details: Detail[];
}

export function evaluate(fixtures: Fixture[], sniff = false): Evaluation {
  const t2 = tier2Active();
  const byCategory: Record<string, Counts> = {};
  const byDetector: Record<string, Counts> = {};
  const byType: Record<string, Counts> = {};
  const total = zero();
  const details: Detail[] = [];
  const bump = (m: Record<string, Counts>, k: string, f: (c: Counts) => void) => f((m[k] ??= zero()));
  for (const fx of fixtures) {
    const a = analyzeFixture(fx, sniff);
    const skip = (t: string) => !t2 && TIER2_TYPES.has(t);
    const exp = fx.spans.filter((s) => !skip(s.type));
    const hits = a.hits.filter((h) => !skip(h.type));
    const used = new Set<number>();
    const lineOf = (pos: number) => fx.text.slice(0, pos).split('\n').length;
    for (const e of exp) {
      const cat = catOf(e.type);
      let best = -1;
      let bi = 0;
      hits.forEach((h, i) => {
        if (used.has(i) || h.category !== cat) return;
        const v = iou(e, h);
        if (v >= 0.5 && v > bi) {
          bi = v;
          best = i;
        }
      });
      bump(byCategory, cat, (c) => void c.expected++);
      bump(byType, e.type, (c) => void c.expected++);
      total.expected++;
      if (best >= 0) {
        used.add(best);
        const h = hits[best];
        const exact = h.start === e.start && h.end === e.end ? 1 : 0;
        bump(byCategory, cat, (c) => {
          c.tp++;
          c.exact += exact;
        });
        bump(byDetector, h.detector, (c) => {
          c.tp++;
          c.exact += exact;
        });
        bump(byType, e.type, (c) => void c.tp++);
        total.tp++;
        total.exact += exact;
      } else {
        bump(byCategory, cat, (c) => void c.fn++);
        bump(byType, e.type, (c) => void c.fn++);
        total.fn++;
        details.push({ fixture: fx.id, kind: 'FN', type: e.type, text: e.text.slice(0, 60), line: lineOf(e.start) });
      }
    }
    hits.forEach((h: Hit, i) => {
      bump(byCategory, h.category, (c) => void c.hits++);
      bump(byDetector, h.detector, (c) => void c.hits++);
      bump(byType, h.type, (c) => void c.hits++);
      total.hits++;
      if (!used.has(i)) {
        bump(byCategory, h.category, (c) => void c.fp++);
        bump(byDetector, h.detector, (c) => void c.fp++);
        bump(byType, h.type, (c) => void c.fp++);
        total.fp++;
        details.push({ fixture: fx.id, kind: 'FP', type: h.type, text: fx.text.slice(h.start, h.end).slice(0, 60), detector: h.detector, reason: h.reason, line: lineOf(h.start) });
      }
    });
  }
  return { byCategory, byDetector, byType, total, details };
}

export const pct = (n: number, d: number) => (d ? (100 * n) / d : 100);
export const precision = (c: Counts) => pct(c.tp, c.tp + c.fp);
export const recall = (c: Counts) => pct(c.tp, c.tp + c.fn);
