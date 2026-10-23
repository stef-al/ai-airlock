import { secretsContext } from './detectors/secrets-context';
import { secretsEntropy } from './detectors/secrets-entropy';
import { secretsKnown } from './detectors/secrets-known';
import { emailDetector, phoneDetector } from './detectors/contact';
import { cardDetector, ibanDetector } from './detectors/financial';
import { columnsDetector, listsDetector, regexDetector } from './detectors/custom';
import { maskHits, type MaskResult } from './mask';
import { Mapping } from './placeholders';
import { resolveHits, type ResolveInput } from './resolve';
import { buildDoc, type BuildOptions } from './segment';
import { resolveConfig } from './settings';
import { Cancelled, SENS_RANK, type Detector, type Doc, type Hit, type PlaceholderStyle, type Scope, type Sensitivity, type Settings } from './types';

export * from './types';
export { Mapping } from './placeholders';
export { restoreText, type RestoreReport } from './restore';
export { defaultSettings, mergeSettings, BUILTIN_PROFILES, exportProfile, parseProfile } from './settings';
export { buildDoc } from './segment';
export { compileUserRegex, regexRisk } from './detectors/custom';
export { regionFromLocale } from './detectors/contact';
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
}

export interface Analysis {
  doc: Doc;
  hits: Hit[];
  ms: number;
}

export function analyze(text: string, settings: Settings, opts: AnalyzeOptions = {}): Analysis {
  const t0 = Date.now();
  const check = opts.check ?? (() => {});
  const doc = buildDoc(text, opts);
  check();
  const ctx = { settings, check };
  const inputs: ResolveInput[] = [];
  for (const d of allDetectors()) {
    const cfg = resolveConfig(settings, d);
    if (!cfg.enabled) continue;
    check();
    const hits = d.detect(doc, cfg, ctx);
    const scopes = new Set<Scope>(cfg.scopes);
    for (const hit of hits) {
      inputs.push({ hit, scopes, minConf: hit.priority >= 4 ? 0 : MIN_CONF[cfg.sensitivity], categoryOn: settings.categories[hit.category]?.enabled !== false });
    }
  }
  check();
  let hits = resolveHits(doc, inputs, settings);
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
