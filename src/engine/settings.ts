import { DEFAULT_KEYWORDS, DEFAULT_QUALIFIERS } from './cues';
import { CATEGORIES, type Category, type DetectorConfig, type Detector, type Profile, type Settings } from './types';

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
  return { name: o.name, settings: o.settings };
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
