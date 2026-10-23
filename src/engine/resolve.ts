import type { Doc, Hit, Scope, Settings } from './types';
import { segIndexAt } from './util';

function scopeOk(doc: Doc, h: Hit, allowed: Set<Scope>): boolean {
  const segs = doc.segments;
  let i = segIndexAt(segs, h.start);
  if (i < 0) return false;
  h.scope = segs[i].scope;
  for (; i < segs.length && segs[i].start < h.end; i++) {
    const s = segs[i];
    if (s.scope === 'structure') {
      const a = Math.max(s.start, h.start);
      const b = Math.min(s.end, h.end);
      if (/\S/.test(doc.text.slice(a, b))) return false;
      continue;
    }
    if (!allowed.has(s.scope)) return false;
  }
  return true;
}

const reCache = new Map<string, RegExp | null>();
function allowRegex(src: string): RegExp | null {
  if (reCache.has(src)) return reCache.get(src)!;
  let r: RegExp | null = null;
  try {
    r = new RegExp(src, 'i');
  } catch {
    r = null;
  }
  if (reCache.size > 200) reCache.clear();
  reCache.set(src, r);
  return r;
}

export function isAllowed(hitText: string, allow: Settings['allowlist']): boolean {
  const lower = hitText.toLowerCase();
  for (const t of allow.terms) {
    const term = t.trim().toLowerCase();
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      const pre = at > 0 ? lower[at - 1] : '';
      const post = lower[at + term.length] ?? '';
      if (!/[a-z0-9]/.test(pre) && !/[a-z0-9]/.test(post)) return true;
      from = at + 1;
    }
  }
  for (const src of allow.regexes) {
    const re = allowRegex(src);
    if (re && re.test(hitText)) return true;
  }
  return false;
}

export interface ResolveInput {
  hit: Hit;
  scopes: Set<Scope>;
  minConf: number;
  categoryOn: boolean;
}

/** Scope filter, allowlist, confidence floor and overlap resolution. */
export function resolveHits(doc: Doc, inputs: ResolveInput[], settings: Settings): Hit[] {
  const ok: Hit[] = [];
  for (const { hit, scopes, minConf, categoryOn } of inputs) {
    if (!categoryOn || hit.confidence < minConf) continue;
    if (hit.end <= hit.start) continue;
    if (!scopeOk(doc, hit, scopes)) continue;
    if (isAllowed(doc.text.slice(hit.start, hit.end), settings.allowlist)) continue;
    ok.push(hit);
  }
  ok.sort((a, b) => b.priority - a.priority || b.confidence - a.confidence || b.end - b.start - (a.end - a.start) || a.start - b.start);
  // accepted intervals are disjoint; keep them sorted by start for O(log n) overlap checks
  const acc: Hit[] = [];
  const overlaps = (h: Hit): boolean => {
    let lo = 0;
    let hi = acc.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (acc[mid].start < h.start) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && acc[lo - 1].end > h.start) return true;
    if (lo < acc.length && acc[lo].start < h.end) return true;
    return false;
  };
  for (const h of ok) {
    if (overlaps(h)) continue;
    let lo = 0;
    let hi = acc.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (acc[mid].start < h.start) lo = mid + 1;
      else hi = mid;
    }
    acc.splice(lo, 0, h);
  }
  return acc;
}
