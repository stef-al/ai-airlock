import { buildDoc } from './segment';
import type { Doc, SegScope } from './types';

export interface GuardResult {
  ok: boolean;
  /** false when nothing needed checking (plain prose) */
  checked: boolean;
  issues: string[];
  /** replacements dropped because they would have broken the structure */
  skipped: number;
  runs: number;
}

function shape(t: string): string {
  if (!/^[A-Za-z_$][\w$-]*$/.test(t)) return 'invalid';
  if (/^[A-Z0-9_]+$/.test(t)) return 'UPPER';
  if (/^[a-z0-9_]+$/.test(t)) return t.includes('_') ? 'snake' : 'lower';
  if (/-/.test(t)) return 'kebab';
  if (/^[a-z]/.test(t)) return 'camel';
  return 'Pascal';
}

/**
 * Token list that captures everything that must not change: structure text, keys and identifiers
 * (compared by shape in scopes the user chose to mask), and the kind/quote of every value.
 * `pos` receives the text offset of each token.
 */
export function skeleton(doc: Doc, relaxed: Set<SegScope>, pos?: number[]): string[] {
  const out: string[] = [];
  let lastVal = '';
  const t = doc.text;
  for (const s of doc.segments) {
    let tok: string;
    if (s.scope === 'structure') {
      const txt = t.slice(s.start, s.end);
      if (!/\S/.test(txt)) continue;
      tok = 'S:' + txt.replace(/\s+/g, ' ');
      lastVal = '';
    } else if (s.scope === 'key' || s.scope === 'identifier') {
      const txt = t.slice(s.start, s.end);
      tok = relaxed.has(s.scope) ? `${s.scope}~${shape(txt)}` : `${s.scope}:${txt}`;
      lastVal = '';
    } else {
      tok = `V:${s.scope}:${s.vt ?? ''}:${s.quote ?? ''}${s.bare ? 'b' : ''}`;
      if (tok === lastVal) continue;
      lastVal = tok;
    }
    out.push(tok);
    pos?.push(s.start);
  }
  return out;
}

/** Index of the first differing token, or -1 when equal. */
export function firstDifference(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export function compareSkeleton(a: string[], b: string[]): string | null {
  const i = firstDifference(a, b);
  if (i < 0) return null;
  if (i < a.length && i < b.length) return `expected ${a[i].slice(0, 60)} but found ${b[i].slice(0, 60)}`;
  return `token count changed (${a.length} → ${b.length})`;
}

export interface GuardIssue {
  message: string;
  /** offset in the masked text where the structure first differs (unknown for parse errors) */
  at?: number;
}

export class Guard {
  private base: string[];
  runs = 0;
  constructor(private orig: Doc) {
    this.base = skeleton(orig, new Set());
  }
  get trivial(): boolean {
    return this.orig.format === 'prose' || this.orig.format === 'log';
  }
  /** Returns null when the masked text has the same structure, otherwise what changed and where. */
  check(masked: string, relaxed: Set<SegScope>): GuardIssue | null {
    if (this.trivial) return null;
    this.runs++;
    const d = buildDoc(masked, { format: this.orig.format, lang: this.orig.lang });
    const base = relaxed.size ? skeleton(this.orig, relaxed) : this.base;
    const pos: number[] = [];
    const got = skeleton(d, relaxed, pos);
    const i = firstDifference(base, got);
    const at = i < 0 ? undefined : i < pos.length ? pos[i] : masked.length;
    if (d.errors > this.orig.errors) return { message: `parse errors increased (${this.orig.errors} → ${d.errors})`, at };
    if (i < 0) return null;
    return { message: compareSkeleton(base, got)!, at };
  }
}
