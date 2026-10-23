import type { Doc, Hit, PlaceholderStyle } from './types';
import { segAt } from './util';

/** One masked value. Identity is the exact original string, so restore is byte-exact. */
export interface Entry {
  id: string; // TYPE_N
  type: string;
  n: number;
  original: string;
  fake?: string;
}

export interface MappingSnapshot {
  entries: Entry[];
  counters: [string, number][];
  reservedIds: string[];
  reservedFakes: string[];
}

const normType = (t: string) => t.toUpperCase().replace(/_/g, '');
export const normKey = (type: string, n: number | string) => normType(type) + Number(n);

const RES_RE = /[A-Za-z][A-Za-z_]{1,30}?[_-]?\d{1,6}|\b\d{3,18}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const RES_CAP = 300000;

export class Mapping {
  private byOriginal = new Map<string, Entry>();
  private byNorm = new Map<string, Entry>();
  private byFakeMap = new Map<string, Entry>();
  private counters = new Map<string, number>();
  private reservedIds = new Set<string>();
  private reservedFakes = new Set<string>();

  get size(): number {
    return this.byOriginal.size;
  }
  entries(): Entry[] {
    return [...this.byOriginal.values()];
  }
  has(original: string): boolean {
    return this.byOriginal.has(original);
  }
  lookupNorm(type: string, n: number | string): Entry | undefined {
    return this.byNorm.get(normKey(type, n));
  }
  lookupFake(s: string): Entry | undefined {
    return this.byFakeMap.get(s.toLowerCase());
  }
  fakeEntries(): Entry[] {
    return [...this.byFakeMap.values()];
  }
  clear(): void {
    this.byOriginal.clear();
    this.byNorm.clear();
    this.byFakeMap.clear();
    this.counters.clear();
    this.reservedIds.clear();
    this.reservedFakes.clear();
  }

  /** Remember tokens already present in an input so generated placeholders never clash with them. */
  reserveFrom(text: string): void {
    if (this.reservedIds.size + this.reservedFakes.size > RES_CAP) return;
    RES_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = RES_RE.exec(text))) {
      if (++n > 100000) break;
      const tok = m[0];
      this.reservedFakes.add(tok.toLowerCase());
      const mm = /^([A-Za-z][A-Za-z_]*?)[_-]?(\d{1,6})$/.exec(tok);
      if (mm) this.reservedIds.add(normKey(mm[1], mm[2]));
    }
  }

  isReservedFake(s: string): boolean {
    const l = s.toLowerCase();
    return this.reservedFakes.has(l) || this.byFakeMap.has(l);
  }

  /** Get or create the entry for an original value. */
  allocate(type: string, original: string): Entry {
    const have = this.byOriginal.get(original);
    if (have) return have;
    let n = (this.counters.get(type) ?? 0) + 1;
    while (this.reservedIds.has(normKey(type, n)) || this.byNorm.has(normKey(type, n))) n++;
    this.counters.set(type, n);
    const e: Entry = { id: `${type}_${n}`, type, n, original };
    this.byOriginal.set(original, e);
    this.byNorm.set(normKey(type, n), e);
    return e;
  }

  /** Forget an entry that ended up unused (its replacement was skipped). */
  release(e: Entry): void {
    if (this.byOriginal.get(e.original) !== e) return;
    this.byOriginal.delete(e.original);
    this.byNorm.delete(normKey(e.type, e.n));
    if (e.fake) this.byFakeMap.delete(e.fake.toLowerCase());
  }

  setFake(e: Entry, fake: string): void {
    e.fake = fake;
    this.byFakeMap.set(fake.toLowerCase(), e);
  }

  snapshot(): MappingSnapshot {
    return {
      entries: this.entries().map((e) => ({ ...e })),
      counters: [...this.counters],
      reservedIds: [...this.reservedIds],
      reservedFakes: [...this.reservedFakes],
    };
  }

  static from(s: MappingSnapshot | undefined): Mapping {
    const m = new Mapping();
    if (!s) return m;
    for (const e of s.entries) {
      const c = { ...e };
      m.byOriginal.set(c.original, c);
      m.byNorm.set(normKey(c.type, c.n), c);
      if (c.fake) m.byFakeMap.set(c.fake.toLowerCase(), c);
    }
    m.counters = new Map(s.counters);
    m.reservedIds = new Set(s.reservedIds);
    m.reservedFakes = new Set(s.reservedFakes);
    return m;
  }
}

// ---------------------------------------------------------------------------------------------
// hosts: where does the placeholder land?
// ---------------------------------------------------------------------------------------------

export type HostKind = 'text' | 'bare' | 'number' | 'identifier';
export interface Host {
  kind: HostKind;
  /** lands in a string literal / config value (not free text) */
  inCode: boolean;
  identText?: string;
  identAtStart?: boolean;
}

export function hostOf(doc: Doc, h: Hit): Host {
  const seg = segAt(doc, h.start);
  const text = doc.text;
  const orig = text.slice(h.start, h.end);
  if (!seg) return { kind: 'text', inCode: false };
  if (seg.scope === 'identifier' || seg.scope === 'key') {
    return { kind: 'identifier', inCode: true, identText: text.slice(seg.start, seg.end), identAtStart: h.start === seg.start };
  }
  const inCode = seg.scope === 'string' || seg.scope === 'config';
  if (seg.vt === 'num' && /^\d+$/.test(orig) && h.start === seg.start && h.end === seg.end) return { kind: 'number', inCode };
  if (seg.bare) return { kind: 'bare', inCode };
  // inside a URL / query string
  let a = h.start;
  while (a > 0 && h.start - a < 240 && !/[\s"'`<>()]/.test(text[a - 1])) a--;
  const tokenBefore = text.slice(a, h.start);
  if (/:\/\//.test(tokenBefore) || /[?&][\w.-]+=$/.test(tokenBefore)) return { kind: 'bare', inCode };
  return { kind: 'text', inCode };
}

// ---------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------

const ALWAYS_FAKE_IN_CODE = new Set(['EMAIL']);
const ALWAYS_FAKE = new Set(['IP', 'IPV6', 'MAC']);
/** Valid inside paths without escaping, so never wrapped in brackets. */
const BARE_ONLY = new Set(['USERNAME']);

function words(type: string): string {
  return type
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

export function identifierForm(type: string, n: number, identText: string, atStart: boolean): string {
  const base = words(type);
  const letters = identText.replace(/[^A-Za-z]/g, '');
  const allUpper = letters.length > 0 && letters === letters.toUpperCase();
  const hasUnderscore = identText.includes('_') || identText.includes('-');
  if (allUpper && (hasUnderscore || letters.length > 3)) return base.toUpperCase() + n;
  if (!allUpper && atStart && /^[a-z]/.test(identText)) return base.charAt(0).toLowerCase() + base.slice(1) + n;
  if (allUpper) return base.toUpperCase() + n;
  return base + n;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Shape-preserving random replacement: letters and digits are randomised (case kept), every other
 * character stays, so the fake is valid wherever the original was (URLs, shell words, quotes).
 */
export function shapeFake(original: string, seed: number): string {
  const rnd = mulberry32(seed);
  let out = '';
  for (const ch of original) {
    if (/\d/.test(ch)) out += String(Math.floor(rnd() * 10));
    else if (/[A-Z]/.test(ch) || (ch !== ch.toLowerCase() && /\p{L}/u.test(ch))) out += String.fromCharCode(65 + Math.floor(rnd() * 26));
    else if (/\p{L}/u.test(ch)) out += String.fromCharCode(97 + Math.floor(rnd() * 26));
    else out += ch;
  }
  return out;
}

/** Fakes with a fixed format (prefix + counter); everything else is a random shape fake. */
export const FORMAT_FAKE_TYPES = new Set(['EMAIL', 'IP', 'IPV6', 'MAC', 'HOST', 'CARD', 'IBAN', 'PHONE']);

function luhnCheckDigit(body: string): string {
  let sum = 0;
  let alt = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let d = body.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}

function ibanCheck(cc: string, bban: string): string {
  const s = bban + cc + '00';
  let rem = 0;
  for (const ch of s) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    rem = v > 9 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return String(98 - rem).padStart(2, '0');
}

/** Format-preserving fake for a type; null when no sensible fake exists. */
export function makeFake(e: Entry, mapping: Mapping, salt = 0): string | null {
  const { type, n, original } = e;
  const seed = hash(type + n + salt);
  const ok = (s: string) => s !== original && !mapping.isReservedFake(s);
  switch (type) {
    case 'EMAIL': {
      const s = `user${n + salt * 1000}@example.com`;
      return ok(s) ? s : makeFake(e, mapping, salt + 1);
    }
    case 'IP': {
      const blocks = ['192.0.2', '198.51.100', '203.0.113'];
      const idx = n - 1 + salt;
      if (idx >= 254 * 3) return null;
      const s = `${blocks[Math.floor(idx / 254)]}.${(idx % 254) + 1}`;
      return ok(s) ? s : makeFake(e, mapping, salt + 1);
    }
    case 'IPV6': {
      const s = `2001:db8::${(n + salt).toString(16)}`;
      return ok(s) ? s : makeFake(e, mapping, salt + 1);
    }
    case 'MAC': {
      const v = n + salt;
      if (v > 255) return null;
      const sep = /-/.test(original) ? '-' : ':';
      const s = ['00', '00', '5e', '00', '53', v.toString(16).padStart(2, '0')].join(sep);
      const out = original === original.toUpperCase() ? s.toUpperCase() : s;
      return ok(out) ? out : makeFake(e, mapping, salt + 1);
    }
    case 'HOST': {
      const s = `srv${n + salt * 1000}.example.net`;
      return ok(s) ? s : makeFake(e, mapping, salt + 1);
    }
    case 'CARD': {
      const digits = original.replace(/\D/g, '');
      const rnd = mulberry32(seed);
      let body = digits[0] ?? '4';
      while (body.length < digits.length - 1) body += String(Math.floor(rnd() * 10));
      body += luhnCheckDigit(body);
      let i = 0;
      const s = original.replace(/\d/g, () => body[i++]);
      return ok(s) ? s : salt < 20 ? makeFake(e, mapping, salt + 1) : null;
    }
    case 'IBAN': {
      const compact = original.replace(/[\s-]/g, '').toUpperCase();
      const cc = compact.slice(0, 2);
      const rnd = mulberry32(seed);
      let bban = '';
      for (let i = 4; i < compact.length; i++) bban += /\d/.test(compact[i]) ? String(Math.floor(rnd() * 10)) : String.fromCharCode(65 + Math.floor(rnd() * 26));
      const raw = cc + ibanCheck(cc, bban) + bban;
      let i = 0;
      const s = original.replace(/[A-Za-z0-9]/g, () => raw[i++] ?? '');
      return ok(s) ? s : salt < 20 ? makeFake(e, mapping, salt + 1) : null;
    }
    case 'PHONE': {
      let i = 0;
      const rnd = mulberry32(seed);
      const digits = original.replace(/\D/g, '');
      const keep = Math.min(2, Math.max(0, digits.length - 8));
      const s = original.replace(/\d/g, (d) => (i++ < keep ? d : String(Math.floor(rnd() * 10))));
      return ok(s) ? s : salt < 20 ? makeFake(e, mapping, salt + 1) : null;
    }
    default: {
      if ((original.match(/[\p{L}\d]/gu) ?? []).length < 6) return null;
      const s = shapeFake(original, seed);
      return ok(s) ? s : salt < 20 ? makeFake(e, mapping, salt + 1) : null;
    }
  }
}

function numberFake(e: Entry, mapping: Mapping): string | null {
  const L = e.original.length;
  if (L < 3) return null;
  const base = 10 ** (L - 1);
  for (let k = 0; k < 50; k++) {
    const v = base + e.n + k * 997;
    if (v >= 10 ** L) return null;
    const s = String(v);
    if (s !== e.original && !mapping.isReservedFake(s)) {
      return s;
    }
  }
  return null;
}

export const REDACTION = '█████';

/**
 * Candidate placeholders for an entry in a host, best first. The first candidate is used unless
 * the structure guard rejects it.
 */
export function candidatesFor(e: Entry, host: Host, style: PlaceholderStyle, mapping: Mapping): string[] {
  // a number stays a number (JSON/YAML numbers cannot hold the block characters)
  if (style === 'redact') return host.kind === 'number' ? ['0', REDACTION] : [REDACTION];
  const out: string[] = [];
  const token = e.id;
  const wantFake =
    style === 'fake' ||
    ALWAYS_FAKE.has(e.type) ||
    (ALWAYS_FAKE_IN_CODE.has(e.type) && host.inCode && host.kind !== 'identifier') ||
    (e.type === 'HOST' && (host.inCode || host.kind === 'bare'));
  const fake = () => {
    if (!e.fake) {
      const f = makeFake(e, mapping);
      if (f) mapping.setFake(e, f);
    }
    return e.fake ?? null;
  };
  if (host.kind === 'identifier') {
    out.push(identifierForm(e.type, e.n, host.identText ?? '', host.identAtStart ?? false));
    return out;
  }
  if (host.kind === 'number') {
    const same = e.fake && /^\d+$/.test(e.fake) && e.fake.length === e.original.length ? e.fake : null;
    const nf = same ?? numberFake(e, mapping);
    if (nf) {
      mapping.setFake(e, nf);
      out.push(nf);
    }
    out.push(token);
    return out;
  }
  if (wantFake) {
    const f = fake();
    if (f) out.push(f);
  }
  if (host.kind === 'bare' || BARE_ONLY.has(e.type)) out.push(token, `[${token}]`);
  else out.push(`[${token}]`, token);
  if (!wantFake) {
    const f = fake();
    if (f && style !== 'token') out.push(f);
  }
  return [...new Set(out)];
}
