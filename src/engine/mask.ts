import { Guard, type GuardResult } from './guard';
import { candidatesFor, hostOf, type Host, Mapping } from './placeholders';
import type { Doc, Hit, PlaceholderStyle, SegScope } from './types';
import { segAt } from './util';

export interface Replacement {
  start: number;
  end: number;
  outStart: number;
  outEnd: number;
  hit: Hit;
  placeholder: string;
  /** entry id (TYPE_N), null for irreversible redaction */
  id: string | null;
  original: string;
}

export interface MaskResult {
  output: string;
  replacements: Replacement[];
  skipped: Hit[];
  guard: GuardResult;
}

interface Plan {
  hit: Hit;
  host: Host;
  cands: string[];
  idx: number;
  id: string | null;
  skip: boolean;
}

export interface StyleResolver {
  (hit: Hit): PlaceholderStyle;
}

function assemble(text: string, plans: Plan[], upTo: number): string {
  let out = '';
  let pos = 0;
  for (let i = 0; i < upTo && i < plans.length; i++) {
    const p = plans[i];
    if (p.skip) continue;
    out += text.slice(pos, p.hit.start) + p.cands[p.idx];
    pos = p.hit.end;
  }
  return out + text.slice(pos);
}

function relaxedScopes(doc: Doc, plans: Plan[], upTo: number): Set<SegScope> {
  const r = new Set<SegScope>();
  for (let i = 0; i < upTo && i < plans.length; i++) {
    if (plans[i].skip) continue;
    const s = segAt(doc, plans[i].hit.start);
    if (s && (s.scope === 'identifier' || s.scope === 'key')) r.add(s.scope);
  }
  return r;
}

const MAX_GUARD_RUNS = 80;

/**
 * Replace the given (non-overlapping, sorted) hits by placeholders, then verify with the structure
 * guard that nothing structural changed. Culprits get an alternative placeholder or are skipped.
 */
export function maskHits(doc: Doc, hits: Hit[], mapping: Mapping, styleOf: StyleResolver): MaskResult {
  const text = doc.text;
  mapping.reserveFrom(text);
  const plans: Plan[] = hits.map((hit) => {
    const orig = text.slice(hit.start, hit.end);
    const style = styleOf(hit);
    const host = hostOf(doc, hit);
    if (style === 'redact') return { hit, host, cands: candidatesFor({ id: '', type: hit.type, n: 0, original: orig }, host, style, mapping), idx: 0, id: null, skip: false };
    const entry = mapping.allocate(hit.type, orig);
    return { hit, host, cands: candidatesFor(entry, host, style, mapping), idx: 0, id: entry.id, skip: false };
  });

  const guard = new Guard(doc);
  const issues: string[] = [];
  let skippedCount = 0;
  const fullCheck = () => guard.check(assemble(text, plans, plans.length), relaxedScopes(doc, plans, plans.length));
  let err = guard.trivial ? null : fullCheck();
  if (err) {
    // locate culprits by binary search on the number of applied replacements
    for (let round = 0; round < 40 && err && guard.runs < MAX_GUARD_RUNS; round++) {
      let lo = 0;
      let hi = plans.length;
      while (hi - lo > 1 && guard.runs < MAX_GUARD_RUNS) {
        const mid = (lo + hi) >> 1;
        if (guard.check(assemble(text, plans, mid), relaxedScopes(doc, plans, mid)) === null) lo = mid;
        else hi = mid;
      }
      const p = plans[hi - 1];
      if (!p) break;
      if (guard.runs >= MAX_GUARD_RUNS) {
        // out of budget: drop everything not yet proven safe
        for (let i = lo; i < plans.length; i++) {
          if (!plans[i].skip) {
            plans[i].skip = true;
            skippedCount++;
          }
        }
        issues.push('guard budget exhausted; unverified replacements were not applied');
        err = null;
        break;
      }
      let fixed = false;
      for (let c = p.idx + 1; c < p.cands.length; c++) {
        p.idx = c;
        if (guard.check(assemble(text, plans, hi), relaxedScopes(doc, plans, hi)) === null) {
          fixed = true;
          break;
        }
      }
      if (!fixed) {
        p.skip = true;
        skippedCount++;
        issues.push(`skipped ${p.hit.type} at ${p.hit.start}: ${err}`);
      }
      err = fullCheck();
    }
    if (err) {
      issues.push(err);
    }
  }

  const replacements: Replacement[] = [];
  const skipped: Hit[] = [];
  let out = '';
  let pos = 0;
  for (const p of plans) {
    if (p.skip) {
      skipped.push(p.hit);
      continue;
    }
    out += text.slice(pos, p.hit.start);
    const ph = p.cands[p.idx];
    replacements.push({
      start: p.hit.start,
      end: p.hit.end,
      outStart: out.length,
      outEnd: out.length + ph.length,
      hit: p.hit,
      placeholder: ph,
      id: p.id,
      original: text.slice(p.hit.start, p.hit.end),
    });
    out += ph;
    pos = p.hit.end;
  }
  out += text.slice(pos);
  return {
    output: out,
    replacements,
    skipped,
    guard: { ok: !err, checked: !guard.trivial, issues, skipped: skippedCount, runs: guard.runs },
  };
}
