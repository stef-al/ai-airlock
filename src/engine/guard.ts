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
 */
export function skeleton(doc: Doc, relaxed: Set<SegScope>): string[] {
  const out: string[] = [];
  let lastVal = '';
  const t = doc.text;
  for (const s of doc.segments) {
    if (s.scope === 'structure') {
      const txt = t.slice(s.start, s.end);
      if (!/\S/.test(txt)) continue;
      out.push('S:' + txt.replace(/\s+/g, ' '));
      lastVal = '';
    } else if (s.scope === 'key' || s.scope === 'identifier') {
      const txt = t.slice(s.start, s.end);
      out.push(relaxed.has(s.scope) ? `${s.scope}~${shape(txt)}` : `${s.scope}:${txt}`);
      lastVal = '';
    } else {
      const tok = `V:${s.scope}:${s.vt ?? ''}:${s.quote ?? ''}${s.bare ? 'b' : ''}`;
      if (tok !== lastVal) out.push(tok);
      lastVal = tok;
    }
  }
  return out;
}

export function compareSkeleton(a: string[], b: string[]): string | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `expected ${a[i].slice(0, 60)} but found ${b[i].slice(0, 60)}`;
  }
  if (a.length !== b.length) return `token count changed (${a.length} → ${b.length})`;
  return null;
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
  /** Returns null when the masked text has the same structure, otherwise a description. */
  check(masked: string, relaxed: Set<SegScope>): string | null {
    if (this.trivial) return null;
    this.runs++;
    const d = buildDoc(masked, { format: this.orig.format, lang: this.orig.lang });
    if (d.errors > this.orig.errors) return `parse errors increased (${this.orig.errors} → ${d.errors})`;
    const base = relaxed.size ? skeleton(this.orig, relaxed) : this.base;
    return compareSkeleton(base, skeleton(d, relaxed));
  }
}
