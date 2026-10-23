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
  // owner[pos] = index into ok of the accepted hit covering pos (-1 = free); linear overall
  const owner = new Int32Array(doc.text.length + 1).fill(-1);
  const accepted = new Set<number>();
  const rejected: number[] = [];
  const free = (h: Hit) => {
    for (let p = h.start; p < h.end; p++) if (owner[p] !== -1) return false;
    return true;
  };
  const claim = (h: Hit, id: number) => {
    owner.fill(id, h.start, h.end);
    accepted.add(id);
  };
  ok.forEach((h, id) => {
    if (free(h)) claim(h, id);
    else rejected.push(id);
  });
  // a longer hit that fully contains lower-priority hits wins (an email containing a client name)
  rejected.sort((a, b) => ok[b].end - ok[b].start - (ok[a].end - ok[a].start));
  for (const xi of rejected) {
    const x = ok[xi];
    if (x.priority < 2) continue;
    const inside = new Set<number>();
    for (let p = x.start; p < x.end; p++) if (owner[p] !== -1) inside.add(owner[p]);
    if (!inside.size) continue;
    let upgrade = true;
    for (const id of inside) {
      const a = ok[id];
      // only user lists/rules (priority 4) give way to a longer automatic hit around them
      if (!(x.start <= a.start && a.end <= x.end && x.end - x.start > a.end - a.start && a.priority === 4 && x.priority < 4)) {
        upgrade = false;
        break;
      }
    }
    if (!upgrade) continue;
    for (const id of inside) {
      owner.fill(-1, ok[id].start, ok[id].end);
      accepted.delete(id);
    }
    claim(x, xi);
  }
  const acc = [...accepted].map((id) => ok[id]).sort((a, b) => a.start - b.start);
  return acc;
}
