import { Guard, type GuardResult } from './guard';
import { candidatesFor, hostOf, type Entry, type Host, Mapping } from './placeholders';
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
  /** the mapping entry was created for this replacement (released again if it is skipped) */
  entry?: Entry;
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

/** The guard re-parses the whole output per check: bound the work by runs and by time. */
const MAX_GUARD_RUNS = 400;
const GUARD_MS = 3000;

/** Offsets of each applied placeholder in the fully assembled output (-1 when skipped). */
function outStarts(text: string, plans: Plan[]): number[] {
  const at: number[] = [];
  let shift = 0;
  for (const p of plans) {
    if (p.skip) {
      at.push(-1);
      continue;
    }
    at.push(p.hit.start + shift);
    shift += p.cands[p.idx].length - (p.hit.end - p.hit.start);
  }
  return at;
}

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
    const known = mapping.has(orig);
    const entry = mapping.allocate(hit.type, orig);
    return { hit, host, cands: candidatesFor(entry, host, style, mapping), idx: 0, id: entry.id, skip: false, entry: known ? undefined : entry };
  });

  const guard = new Guard(doc);
  const deadline = Date.now() + GUARD_MS;
  const spent = () => guard.runs >= MAX_GUARD_RUNS || Date.now() > deadline;
  const issues: string[] = [];
  let skippedCount = 0;
  const checkPrefix = (upTo: number) => guard.check(assemble(text, plans, upTo), relaxedScopes(doc, plans, upTo));
  const ok = (upTo: number) => checkPrefix(upTo) === null;
  let err = guard.trivial ? null : checkPrefix(plans.length);
  // Each round finds the first culprit: the replacement i such that the first i are fine and the
  // first i+1 are not. The place where the structure first differs usually points right at it
  // (two checks); otherwise binary search. The culprit gets its next candidate, or is skipped.
  for (let round = 0; err && round < 60; round++) {
    if (spent()) {
      // out of budget: keep the remaining replacements (a leak is worse than a broken structure)
      issues.push('structure check budget exhausted: some replacements could not be verified');
      break;
    }
    let hi = -1;
    if (err.at !== undefined) {
      const at = outStarts(text, plans);
      let g = -1;
      for (let i = 0; i < plans.length; i++) if (at[i] >= 0 && at[i] <= err.at) g = i;
      if (g >= 0 && ok(g) && !ok(g + 1)) hi = g + 1;
    }
    if (hi < 0) {
      let lo = 0;
      hi = plans.length;
      while (hi - lo > 1 && !spent()) {
        const mid = (lo + hi) >> 1;
        if (ok(mid)) lo = mid;
        else hi = mid;
      }
      if (hi - lo > 1) continue; // budget ran out mid-search
    }
    const p = plans[hi - 1];
    if (!p) break;
    let fixed = false;
    while (p.idx + 1 < p.cands.length && !spent()) {
      p.idx++;
      if (ok(hi)) {
        fixed = true;
        break;
      }
    }
    if (!fixed) {
      p.skip = true;
      skippedCount++;
      issues.push(`skipped ${p.hit.type} at ${p.hit.start}: ${err.message}`);
    }
    err = checkPrefix(plans.length);
  }
  if (err) issues.push(err.message);

  const used = new Set(plans.filter((p) => !p.skip).map((p) => p.id));
  for (const p of plans) if (p.skip && p.entry && !used.has(p.id)) mapping.release(p.entry);

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
