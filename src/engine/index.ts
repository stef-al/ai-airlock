import { secretsContext } from './detectors/secrets-context';
import { secretsEntropy } from './detectors/secrets-entropy';
import { secretsKnown } from './detectors/secrets-known';
import { emailDetector, phoneDetector } from './detectors/contact';
import { cardDetector, ibanDetector } from './detectors/financial';
import { columnsDetector, listsDetector, regexDetector } from './detectors/custom';
import { embeddedImages } from './detectors/embedded';
import { idsDetector } from './detectors/ids';
import { personDetector } from './detectors/names';
import { hostDetector, ipDetector, macDetector } from './detectors/network';
import { orgDetector } from './detectors/orgs';
import { dobDetector, usernameDetector } from './detectors/personal';
import { maskHits, type MaskResult } from './mask';
import { Mapping } from './placeholders';
import { resolveHits, type ResolveInput } from './resolve';
import { escapeRegExp } from './util';
import { buildDoc, type BuildOptions } from './segment';
import { resolveConfig } from './settings';
import { Cancelled, SENS_RANK, type Detector, type Doc, type Hit, type PlaceholderStyle, type Scope, type Sensitivity, type Settings } from './types';

export * from './types';
export { Mapping } from './placeholders';
export { restoreText, type RestoreReport } from './restore';
export { defaultSettings, mergeSettings, BUILTIN_PROFILES, exportProfile, parseProfile } from './settings';
export { buildDoc } from './segment';
export { compileUserRegex, regexRisk, typeName } from './userRegex';
export { regionFromLocale } from './settings';
export type { MaskResult } from './mask';

const extra: Detector[] = [];
/** Tier 2 modules register themselves here. */
export function registerDetector(d: Detector): void {
  if (!extra.some((x) => x.id === d.id)) extra.push(d);
}

export const BASE_DETECTORS: Detector[] = [
  secretsKnown,
  secretsContext,
  secretsEntropy,
  emailDetector,
  phoneDetector,
  ibanDetector,
  cardDetector,
  listsDetector,
  regexDetector,
  columnsDetector,
  // tier 2
  personDetector,
  orgDetector,
  ipDetector,
  macDetector,
  hostDetector,
  usernameDetector,
  dobDetector,
  idsDetector,
  embeddedImages,
];

export function allDetectors(): Detector[] {
  return [...BASE_DETECTORS, ...extra];
}

const MIN_CONF: Record<Sensitivity, number> = { strict: 0.8, balanced: 0.5, aggressive: 0.35 };

export interface AnalyzeOptions extends BuildOptions {
  /** Called between detectors; throw Cancelled to abort. */
  check?: () => void;
  /** Spans (offset:text) the user chose to keep this time. */
  keepOnce?: Set<string>;
  /** text read from an image (OCR): checksummed shapes near a cue count, entropy needs a cue */
  ocr?: boolean;
}

export interface Analysis {
  doc: Doc;
  hits: Hit[];
  ms: number;
}

/** types that are not repeated: images and image regions are not text values */
const NO_REPEAT = new Set(['IMAGE', 'QR', 'MRZ', 'FACE', 'AREA', 'SIGNATURE']);
const WORD = /[A-Za-z0-9_]/;

/**
 * A value found once is masked wherever else it appears ("password=Kv7… and later: the password
 * Kv7… is shared"), with the same placeholder. Exact matches of 6+ characters on token boundaries,
 * in the scopes the original detector may touch.
 */
function repeats(text: string, hits: Hit[], inputs: ResolveInput[]): ResolveInput[] {
  const values = new Map<string, Hit>();
  for (const h of hits) {
    const v = text.slice(h.start, h.end);
    if (v.length >= 6 && v.length <= 200 && !NO_REPEAT.has(h.type) && !h.user && !values.has(v)) values.set(v, h);
    if (values.size >= 1000) break;
  }
  if (!values.size) return [];
  const covered = new Uint8Array(text.length + 1);
  for (const h of hits) covered.fill(1, h.start, h.end);
  const scopesOf = new Map(inputs.map((i) => [i.hit.detector, i.scopes]));
  let starts: number[] | null = null;
  const lineOf = (pos: number) => {
    starts ??= [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const out: ResolveInput[] = [];
  const keys = [...values.keys()].sort((a, b) => b.length - a.length);
  for (let c = 0; c < keys.length; c += 200) {
    const re = new RegExp(keys.slice(c, c + 200).map(escapeRegExp).join('|'), 'g');
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(text)) && ++n < 20000) {
      const s = m.index;
      const e = s + m[0].length;
      if ((WORD.test(m[0][0]) && WORD.test(text[s - 1] ?? '')) || (WORD.test(m[0][m[0].length - 1]) && WORD.test(text[e] ?? ''))) continue;
      if (covered.subarray(s, e).some((x) => x)) continue;
      const o = values.get(m[0])!;
      const hit: Hit = { ...o, start: s, end: e, confidence: Math.min(o.confidence, 0.95), reason: `same value as the ${o.type.toLowerCase().replace(/_/g, ' ')} found on line ${lineOf(o.start)}`, rule: 'repeat' };
      out.push({ hit, scopes: scopesOf.get(o.detector) ?? new Set<Scope>(['prose', 'comment', 'string', 'config']), minConf: 0, categoryOn: true });
    }
  }
  return out;
}

function detectAll(doc: Doc, settings: Settings, ctx: { settings: Settings; check: () => void; ocr: boolean }): ResolveInput[] {
  const inputs: ResolveInput[] = [];
  for (const d of allDetectors()) {
    const cfg = resolveConfig(settings, d);
    if (!cfg.enabled) continue;
    ctx.check();
    const hits = d.detect(doc, cfg, ctx);
    const scopes = new Set<Scope>(cfg.scopes);
    for (const hit of hits) {
      inputs.push({ hit, scopes, minConf: hit.priority >= 4 ? 0 : MIN_CONF[cfg.sensitivity], categoryOn: settings.categories[hit.category]?.enabled !== false });
    }
  }
  return inputs;
}

export function analyze(text: string, settings: Settings, opts: AnalyzeOptions = {}): Analysis {
  const t0 = Date.now();
  const check = opts.check ?? (() => {});
  const doc = buildDoc(text, { ...opts, tolerant: opts.ocr || opts.tolerant });
  check();
  const ctx = { settings, check, ocr: !!opts.ocr };
  let inputs = detectAll(doc, settings, ctx);
  check();
  let hits = resolveHits(doc, inputs, settings);
  let base = doc;
  // OCR text of code or config: OCR damages comment markers and quotes, so free-text rules run on a
  // prose reading as well. Findings of both readings are merged (images are masked as plain text).
  if (opts.ocr && doc.format !== 'prose') {
    const prose = buildDoc(text, { format: 'prose' });
    const extra = resolveHits(prose, detectAll(prose, settings, ctx), settings);
    const all = new Set<Scope>(['prose']);
    inputs = [...hits, ...extra].map((hit) => ({ hit, scopes: all, minConf: 0, categoryOn: true }));
    hits = resolveHits(prose, inputs, settings);
    base = prose;
  }
  const again = repeats(text, hits, inputs);
  if (again.length) hits = resolveHits(base, [...inputs, ...again], settings);
  if (opts.keepOnce?.size) hits = hits.filter((h) => !opts.keepOnce!.has(h.start + ':' + text.slice(h.start, h.end)));
  return { doc, hits, ms: Date.now() - t0 };
}

/** Per-hit placeholder style from the detector / category configuration. */
export function styleResolver(settings: Settings): (h: Hit) => PlaceholderStyle {
  const byId = new Map(allDetectors().map((d) => [d.id, d] as const));
  return (h) => {
    const d = byId.get(h.detector);
    return d ? resolveConfig(settings, d).style : settings.categories[h.category]?.style ?? 'token';
  };
}

export function mask(doc: Doc, hits: Hit[], mapping: Mapping, settings: Settings): MaskResult {
  return maskHits(doc, hits, mapping, styleResolver(settings));
}

/** One-shot helper: detect and mask (used by tests and metrics). */
export function maskText(text: string, settings: Settings, mapping: Mapping = new Mapping(), opts: AnalyzeOptions = {}) {
  const a = analyze(text, settings, opts);
  const m = mask(a.doc, a.hits, mapping, settings);
  return { ...m, hits: a.hits, doc: a.doc, mapping };
}

export { Cancelled, SENS_RANK };
