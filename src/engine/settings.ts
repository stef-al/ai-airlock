import { DEFAULT_KEYWORDS, DEFAULT_QUALIFIERS } from './cues';
import { typeName } from './userRegex';
import {
  CATEGORIES, SCOPES,
  type Category, type CategorySettings, type CustomList, type DetectorConfig, type Detector, type DetectorOverride, type PlaceholderStyle,
  type Profile, type RegexRule, type Scope, type Sensitivity, type Settings,
} from './types';

export function defaultSettings(region = 'US'): Settings {
  const cat = (enabled = true) => ({ enabled });
  return {
    version: 1,
    sensitivity: 'balanced',
    region,
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, cat()])) as Settings['categories'],
    detectors: {},
    keywords: [...DEFAULT_KEYWORDS],
    qualifiers: [...DEFAULT_QUALIFIERS],
    exclusions: { uuid: true, gitSha: true, hashes: true, dataUri: true, cssColor: true, version: true },
    allowlist: { terms: ['example.com', 'example.org', 'example.net'], regexes: [] },
    customLists: [],
    regexRules: [],
    options: {},
  };
}

/** Shallow-per-section merge so profiles can be partial. */
export function mergeSettings(base: Settings, patch: Partial<Settings> | undefined): Settings {
  if (!patch) return base;
  const out: Settings = { ...base, ...patch } as Settings;
  out.categories = { ...base.categories };
  for (const c of CATEGORIES) if (patch.categories?.[c]) out.categories[c] = { ...base.categories[c], ...patch.categories[c] };
  out.detectors = { ...base.detectors, ...(patch.detectors ?? {}) };
  out.exclusions = { ...base.exclusions, ...(patch.exclusions ?? {}) };
  out.allowlist = { ...base.allowlist, ...(patch.allowlist ?? {}) };
  out.options = { ...base.options, ...(patch.options ?? {}) };
  return out;
}

export function resolveConfig(s: Settings, d: Detector): DetectorConfig {
  const cat = s.categories[d.category as Category] ?? { enabled: true };
  const ov = s.detectors[d.id] ?? {};
  return {
    enabled: cat.enabled && (ov.enabled ?? true),
    sensitivity: ov.sensitivity ?? cat.sensitivity ?? s.sensitivity,
    scopes: ov.scopes ?? d.defaultScopes,
    style: ov.style ?? cat.style ?? 'token',
  };
}

export const BUILTIN_PROFILES: Profile[] = [
  {
    name: 'Source code',
    builtin: true,
    settings: {
      sensitivity: 'balanced',
      categories: { secret: { enabled: true, sensitivity: 'aggressive' }, personal: { enabled: true }, financial: { enabled: true }, network: { enabled: true }, custom: { enabled: true } },
      detectors: { 'contact.phone': { enabled: false }, 'secrets.entropy': { sensitivity: 'balanced' } },
    },
  },
  {
    name: 'Config and logs',
    builtin: true,
    settings: {
      sensitivity: 'balanced',
      categories: { secret: { enabled: true, sensitivity: 'aggressive' }, personal: { enabled: true }, financial: { enabled: true }, network: { enabled: true }, custom: { enabled: true } },
      detectors: { 'contact.phone': { sensitivity: 'strict' } },
    },
  },
  {
    name: 'Business text / email',
    builtin: true,
    settings: {
      sensitivity: 'balanced',
      categories: { secret: { enabled: true, sensitivity: 'balanced' }, personal: { enabled: true, sensitivity: 'aggressive' }, financial: { enabled: true }, network: { enabled: false }, custom: { enabled: true } },
      detectors: { 'secrets.entropy': { enabled: false } },
    },
  },
];

export const PROFILE_SCHEMA = 'ai-airlock-profile/1';

export function exportProfile(name: string, s: Settings): string {
  return JSON.stringify({ schema: PROFILE_SCHEMA, name, settings: s }, null, 2);
}

export function parseProfile(json: string): Profile {
  const o = JSON.parse(json);
  if (!o || typeof o !== 'object' || o.schema !== PROFILE_SCHEMA || typeof o.name !== 'string' || typeof o.settings !== 'object') {
    throw new Error('Not an AI Airlock profile file');
  }
  return { name: o.name.slice(0, 80), settings: sanitizeSettings(o.settings) };
}

const SENSITIVITIES = new Set<string>(['strict', 'balanced', 'aggressive']);
const STYLES = new Set<string>(['token', 'fake', 'redact']);
const EXCLUSIONS = ['uuid', 'gitSha', 'hashes', 'dataUri', 'cssColor', 'version'] as const;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown, max: number, len: number): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= len).slice(0, max) : undefined;
const str = (v: unknown, len: number, def = ''): string => (typeof v === 'string' ? v.slice(0, len) : def);
const sens = (v: unknown) => (SENSITIVITIES.has(v as string) ? (v as Sensitivity) : undefined);
const style = (v: unknown) => (STYLES.has(v as string) ? (v as PlaceholderStyle) : undefined);

/**
 * Keep only the well-formed parts of untrusted settings (localStorage, imported profiles), so a
 * damaged or hand-edited file can never break detection. Unknown keys are dropped.
 */
export function sanitizeSettings(raw: unknown): Partial<Settings> {
  if (!isObj(raw)) return {};
  const out: Partial<Settings> = {};
  if (sens(raw.sensitivity)) out.sensitivity = sens(raw.sensitivity);
  if (typeof raw.region === 'string' && /^[A-Z]{2}$/.test(raw.region)) out.region = raw.region;
  if (isObj(raw.categories)) {
    const cats: Partial<Record<Category, CategorySettings>> = {};
    for (const c of CATEGORIES) {
      const v = raw.categories[c];
      if (!isObj(v)) continue;
      cats[c] = { enabled: v.enabled !== false, ...(sens(v.sensitivity) && { sensitivity: sens(v.sensitivity) }), ...(style(v.style) && { style: style(v.style) }) };
    }
    out.categories = cats as Settings['categories'];
  }
  if (isObj(raw.detectors)) {
    const dets: Record<string, DetectorOverride> = {};
    for (const [id, v] of Object.entries(raw.detectors).slice(0, 200)) {
      if (!isObj(v) || id.length > 80) continue;
      const o: DetectorOverride = {};
      if (typeof v.enabled === 'boolean') o.enabled = v.enabled;
      if (sens(v.sensitivity)) o.sensitivity = sens(v.sensitivity);
      if (style(v.style)) o.style = style(v.style);
      const sc = strList(v.scopes, 10, 20)?.filter((x): x is Scope => (SCOPES as string[]).includes(x));
      if (sc) o.scopes = sc;
      dets[id] = o;
    }
    out.detectors = dets;
  }
  const kw = strList(raw.keywords, 5000, 80);
  if (kw) out.keywords = kw;
  const q = strList(raw.qualifiers, 5000, 80);
  if (q) out.qualifiers = q;
  if (isObj(raw.exclusions)) {
    const ex: Partial<Settings['exclusions']> = {};
    for (const k of EXCLUSIONS) if (typeof raw.exclusions[k] === 'boolean') ex[k] = raw.exclusions[k] as boolean;
    out.exclusions = ex as Settings['exclusions'];
  }
  if (isObj(raw.allowlist)) {
    const terms = strList(raw.allowlist.terms, 10000, 500);
    const regexes = strList(raw.allowlist.regexes, 1000, 500);
    out.allowlist = { ...(terms && { terms }), ...(regexes && { regexes }) } as Settings['allowlist'];
  }
  if (Array.isArray(raw.customLists)) {
    out.customLists = raw.customLists.filter(isObj).slice(0, 200).map(
      (l, i): CustomList => ({ id: str(l.id, 80) || `list-${i}`, name: str(l.name, 80, 'List'), type: typeName(str(l.type, 40, 'CUSTOM')), terms: strList(l.terms, 200000, 300) ?? [], enabled: l.enabled !== false }),
    );
  }
  if (Array.isArray(raw.regexRules)) {
    out.regexRules = raw.regexRules.filter(isObj).filter((r) => typeof r.pattern === 'string').slice(0, 500).map(
      (r, i): RegexRule => ({ id: str(r.id, 80) || `rule-${i}`, name: str(r.name, 80, 'Rule'), type: typeName(str(r.type, 40, 'CUSTOM')), pattern: str(r.pattern, 1000), flags: str(r.flags, 10).replace(/[^imsu]/g, ''), enabled: r.enabled !== false }),
    );
  }
  if (isObj(raw.options)) {
    const o: Settings['options'] = {};
    for (const [k, v] of Object.entries(raw.options).slice(0, 200)) {
      if (k.length > 80) continue;
      if (typeof v === 'boolean') o[k] = v;
      else if (typeof v === 'string') o[k] = v.slice(0, 2000);
      else if (Array.isArray(v)) o[k] = strList(v, 5000, 300) ?? [];
    }
    out.options = o;
  }
  return out;
}

export function regionFromLocale(loc?: string): string {
  const l = loc ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  const m = /[-_]([A-Za-z]{2})\b/.exec(l ?? '');
  return (m ? m[1] : 'US').toUpperCase();
}


/** Typed access to Settings.options with a default. */
export function opt<T extends boolean | string | string[]>(s: Settings, key: string, def: T): T {
  const v = s.options?.[key];
  return (v === undefined ? def : (v as T)) as T;
}

export const DEFAULT_HOST_SUFFIXES = ['internal', 'local', 'lan', 'corp', 'intranet', 'home', 'localdomain', 'private'];
export const ID_PACK_IDS = ['us-ssn', 'uk-nino', 'cz-sk-birth-number', 'pl-pesel'];
