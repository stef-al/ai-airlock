// Core types shared by the whole detection engine (pure TypeScript, no DOM).

export type Category = 'secret' | 'personal' | 'financial' | 'network' | 'custom';
export const CATEGORIES: Category[] = ['secret', 'personal', 'financial', 'network', 'custom'];
export type Sensitivity = 'strict' | 'balanced' | 'aggressive';
export const SENS_RANK: Record<Sensitivity, number> = { strict: 0, balanced: 1, aggressive: 2 };
/** User-selectable scopes. 'structure' is internal and never maskable. */
export type Scope = 'prose' | 'comment' | 'string' | 'config' | 'identifier' | 'key';
export const SCOPES: Scope[] = ['prose', 'comment', 'string', 'config', 'identifier', 'key'];
export type SegScope = Scope | 'structure';
export type PlaceholderStyle = 'token' | 'fake' | 'redact';
export type Format =
  | 'prose' | 'markdown' | 'json' | 'yaml' | 'xml' | 'env' | 'ini' | 'properties' | 'csv' | 'log' | 'code';
export type Lang = 'js' | 'ts' | 'python' | 'java' | 'csharp' | 'go' | 'php' | 'sql' | 'bash' | 'powershell';

/** A contiguous slice of the input with a role. Segments tile the text completely. */
export interface Segment {
  start: number;
  end: number;
  scope: SegScope;
  /** Surrounding quote char for literals ('' = unquoted, 'block' = YAML block scalar, 'heredoc'). */
  quote?: string;
  /** Value type for literal segments. */
  vt?: 'str' | 'num' | 'lit';
  /** Unquoted token where "[X]" would change meaning (YAML plain, env, shell word, URL part). */
  bare?: boolean;
}

/** A key/value association found by a structure-aware segmenter. */
export interface Pair {
  key: string;
  keyStart: number;
  keyEnd: number;
  valStart: number;
  valEnd: number;
  quote: string;
  numeric?: boolean;
  path?: string;
  kind: 'kv' | 'call' | 'cell' | 'element' | 'sql';
  /** e.g. 'k8s-secret', 'docker-auth' */
  hint?: string;
  /** For calls: number of literal args and index of this one. */
  argIndex?: number;
  argCount?: number;
}

export interface Column {
  header: string;
  index: number;
  headerStart: number;
  headerEnd: number;
  cells: { start: number; end: number }[];
}

export interface Doc {
  text: string;
  format: Format;
  lang?: Lang;
  segments: Segment[];
  pairs: Pair[];
  columns: Column[];
  /** Parse errors found by the segmenter (used by the structure guard). */
  errors: number;
  /** Detected credential-file flavour, e.g. 'netrc', 'pgpass', 'npmrc'. */
  fileKind?: string;
}

export interface Hit {
  start: number;
  end: number;
  detector: string;
  type: string;
  category: Category;
  confidence: number;
  reason: string;
  /** Higher wins in overlap resolution: 3 known format, 2 context, 1 heuristic. */
  priority: number;
  rule?: string;
  /** Scope of the segment where the hit starts (filled in by resolve). */
  scope?: SegScope;
  /** Set by the user via the UI. */
  user?: 'mask-once' | 'mask-always';
}

export interface DetectorConfig {
  enabled: boolean;
  sensitivity: Sensitivity;
  scopes: Scope[];
  style: PlaceholderStyle;
}

export interface RunCtx {
  settings: Settings;
  /** Throws when the job was cancelled (used by tests; the worker is terminated instead). */
  check(): void;
}

export interface Detector {
  id: string;
  label: string;
  category: Category;
  /** Types this detector can emit, for settings UI. */
  types: string[];
  defaultScopes: Scope[];
  defaultSensitivity?: Sensitivity;
  detect(doc: Doc, cfg: DetectorConfig, ctx: RunCtx): Hit[];
}

export interface CustomList {
  id: string;
  name: string;
  /** Placeholder type, e.g. CLIENT, PROJECT, PRODUCT, EMPLOYEE (A-Z0-9_). */
  type: string;
  terms: string[];
  enabled: boolean;
}

export interface RegexRule {
  id: string;
  name: string;
  type: string;
  pattern: string;
  flags: string;
  enabled: boolean;
}

export interface DetectorOverride {
  enabled?: boolean;
  sensitivity?: Sensitivity;
  scopes?: Scope[];
  style?: PlaceholderStyle;
}

export interface CategorySettings {
  enabled: boolean;
  sensitivity?: Sensitivity;
  style?: PlaceholderStyle;
}

export interface Settings {
  version: 1;
  /** Global sensitivity preset (categories/detectors may override). */
  sensitivity: Sensitivity;
  /** ISO region for phone parsing, e.g. 'US', 'DE'. */
  region: string;
  categories: Record<Category, CategorySettings>;
  detectors: Record<string, DetectorOverride>;
  /** Cue words that make a name secret-like (editable). */
  keywords: string[];
  /** Words that cancel a cue when part of a name (password_hash, MIN_LENGTH ...). */
  qualifiers: string[];
  exclusions: {
    uuid: boolean;
    gitSha: boolean;
    hashes: boolean;
    dataUri: boolean;
    cssColor: boolean;
    version: boolean;
  };
  allowlist: { terms: string[]; regexes: string[] };
  customLists: CustomList[];
  regexRules: RegexRule[];
  /** Tier 2 options (names, orgs, network, ids). */
  options: Record<string, boolean | string | string[]>;
}

export interface Profile {
  name: string;
  builtin?: boolean;
  settings: Partial<Settings>;
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}
