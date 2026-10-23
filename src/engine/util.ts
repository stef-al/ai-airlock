import type { Doc, Segment, SegScope } from './types';

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // valid under the u flag too (no \- or \/)
}

/** Shannon entropy in bits per character. */
export function shannon(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

export function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
export function isAlnum(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
export function isWordCh(c: string): boolean {
  return isAlnum(c) || c === '_';
}

/** Appends segments in order, filling gaps with 'structure'. */
export class SegBuilder {
  segs: Segment[] = [];
  pos = 0;
  constructor(private len: number) {}
  add(start: number, end: number, scope: SegScope, extra?: Partial<Segment>): void {
    if (end > this.len) end = this.len;
    if (start < this.pos) start = this.pos;
    if (end <= start) return;
    if (start > this.pos) this.segs.push({ start: this.pos, end: start, scope: 'structure' });
    this.segs.push({ start, end, scope, ...extra });
    this.pos = end;
  }
  finish(): Segment[] {
    if (this.pos < this.len) this.segs.push({ start: this.pos, end: this.len, scope: 'structure' });
    return this.segs;
  }
}

/** Index of the segment containing pos (binary search). */
export function segIndexAt(segs: Segment[], pos: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (pos < s.start) hi = mid - 1;
    else if (pos >= s.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function segAt(doc: Doc, pos: number): Segment | undefined {
  const i = segIndexAt(doc.segments, pos);
  return i < 0 ? undefined : doc.segments[i];
}

/** Split a name into lower-case tokens (camelCase, snake_case, kebab-case, dotted, digits). */
export function nameTokens(name: string): string[] {
  const out: string[] = [];
  for (const part of name.split(/[^A-Za-z0-9À-ɏ]+/)) {
    if (!part) continue;
    const m = part.match(/[A-Z]{2,}(?![a-z])|[A-Z]?[a-zß-ɏ]+|[A-Z]+|\d+/g);
    if (m) for (const t of m) out.push(t.toLowerCase());
  }
  return out;
}

/** Character classes present in s: lower, upper, digit, symbol. */
export function charClasses(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/\d/.test(s)) n++;
  if (/[^A-Za-z0-9]/.test(s)) n++;
  return n;
}

export function lineBounds(text: string, pos: number): [number, number] {
  let s = text.lastIndexOf('\n', pos - 1) + 1;
  let e = text.indexOf('\n', pos);
  if (e < 0) e = text.length;
  return [s, e];
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Case-insensitive regex source for a literal, without the i flag (so \p{Lu} classes stay case-sensitive). */
export function ci(s: string): string {
  return [...s]
    .map((c) => {
      const lo = c.toLowerCase();
      const up = c.toUpperCase();
      return lo !== up && lo.length === 1 && up.length === 1 ? `[${lo}${up}]` : escapeRegExp(c);
    })
    .join('');
}

/**
 * Step past an empty match. Under the u/v flag a step into the middle of a surrogate pair is
 * moved back by exec, which would match the same empty string forever: step a whole code point.
 */
export function skipEmpty(re: RegExp, text: string): void {
  const i = re.lastIndex;
  const c = text.charCodeAt(i);
  re.lastIndex = i + ((re.unicode || re.flags.includes('v')) && c >= 0xd800 && c <= 0xdbff ? 2 : 1);
}

export function* matchAll(re: RegExp, text: string, cap = 50000): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) skipEmpty(re, text);
    yield m;
    if (++n > cap) return;
  }
}

export function groupSpan(m: RegExpExecArray, g: number): [number, number] | null {
  const ind = (m as RegExpExecArray & { indices?: ([number, number] | undefined)[] }).indices;
  const r = ind?.[g];
  return r ? [r[0], r[1]] : null;
}
