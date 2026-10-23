import { FUNC_STOP, ORG_LEAD_STOP } from '../data/words';
import { SENS_RANK, type Detector, type Hit } from '../types';
import { escapeRegExp, groupSpan, matchAll } from '../util';
import { mkHit } from './helpers';

const ID = 'names.org';

/** Legal-form suffixes. `dot` = the final period is part of the form and belongs to the hit. */
const SUFFIXES: { re: string; ambiguous?: boolean }[] = [
  { re: 'Ltd' }, { re: 'Limited' }, { re: 'LLC' }, { re: 'L\\.L\\.C\\.' }, { re: 'Inc' }, { re: 'Incorporated' }, { re: 'Corp' }, { re: 'Corporation' },
  { re: 'Co' }, { re: 'Company', ambiguous: true }, { re: 'PLC' }, { re: 'plc' }, { re: 'LLP' }, { re: 'GmbH(?:[ \\t]*&[ \\t]*Co\\.?[ \\t]*KG)?' }, { re: 'mbH' },
  { re: 'AG' }, { re: 'KG' }, { re: 'OHG' }, { re: 'UG' }, { re: 'e\\.V\\.' }, { re: 'eG' }, { re: 'SE', ambiguous: true }, { re: 'S\\.A\\.S\\.' },
  { re: 'S\\.A\\.' }, { re: 'SAS' }, { re: 'SARL' }, { re: 'S\\.r\\.l\\.' }, { re: 'Srl' }, { re: 'S\\.p\\.A\\.' }, { re: 'SpA' }, { re: 'B\\.V\\.' },
  { re: 'BV', ambiguous: true }, { re: 'N\\.V\\.' }, { re: 'NV', ambiguous: true }, { re: 'Oyj' }, { re: 'Oy' }, { re: 'AB', ambiguous: true }, { re: 'ASA', ambiguous: true },
  { re: 'A/S' }, { re: 'ApS' }, { re: 's\\.r\\.o\\.' }, { re: 'spol\\.[ \\t]*s[ \\t]*r\\.o\\.' }, { re: 'a\\.s\\.' }, { re: 'k\\.s\\.' }, { re: 'v\\.o\\.s\\.' },
  { re: 'Sp\\.[ \\t]*z[ \\t]*o\\.[ \\t]*o\\.' }, { re: 'sp\\.[ \\t]*j\\.' }, { re: 'S\\.L\\.U\\.' }, { re: 'S\\.L\\.' }, { re: 'Pty[ \\t]+Ltd' }, { re: 'Pte[ \\t]+Ltd' },
  { re: 'Pvt\\.?[ \\t]+Ltd' }, { re: 'Ltda' }, { re: 'S/A' }, { re: 'K\\.K\\.' }, { re: 'Kft' }, { re: 'Zrt' }, { re: 'd\\.o\\.o\\.' }, { re: 'd\\.d\\.' }, { re: 'Sdn[ \\t]+Bhd' },
];
const SUFFIX_ALT = [...SUFFIXES].sort((a, b) => b.re.length - a.re.length).map((x) => x.re).join('|');
const UP = '\\p{Lu}';
const WORD = `(?:${UP}[\\p{L}\\p{M}\\p{N}'’-]{0,40}|\\d{1,10})`;
const JOIN = '(?:&|and|und|et|y|e|of)'; // not von/van/de: "Dr. Alvarez von Lyon Logistique S.A." is a person from a company
// 1 to 5 words (capitalized or joiners) before the suffix
const RE_ORG = new RegExp(`(?<![\\p{L}\\p{N}])((?:${WORD}|${JOIN})(?:[ \\t]+(?:${WORD}|${JOIN})){0,5}?)[ \\t]+(${SUFFIX_ALT})(?![\\p{L}\\p{N}])`, 'gud');
const MONTHDAY = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)$/i;

function isAmbiguous(suffix: string): boolean {
  return SUFFIXES.some((x) => x.ambiguous && new RegExp(`^${x.re}$`).test(suffix));
}

export const orgDetector: Detector = {
  id: ID,
  label: 'Organizations with legal suffixes (Ltd, GmbH, s.r.o., …)',
  category: 'personal',
  types: ['ORG'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, cfg, ctx) {
    if (SENS_RANK[cfg.sensitivity] < SENS_RANK.balanced) return [];
    const t = doc.text;
    const out: Hit[] = [];
    const stripped = new Map<string, number>();
    for (const m of matchAll(RE_ORG, t)) {
      const g = groupSpan(m, 1)!;
      const sg = groupSpan(m, 2)!;
      const words = [...m[1].matchAll(/\S+/gu)].map((x) => ({ w: x[0], at: x.index! }));
      // drop sentence openers and joiners from the left
      let i = 0;
      while (i < words.length) {
        const w = words[i].w;
        if (ORG_LEAD_STOP.has(w.toLowerCase()) || FUNC_STOP.has(w.toLowerCase()) || MONTHDAY.test(w) || /^\d+$/.test(w) || new RegExp(`^${JOIN}$`, 'i').test(w)) i++;
        else break;
      }
      while (words.length > i && new RegExp(`^${JOIN}$`, 'i').test(words[words.length - 1].w) && words[words.length - 1].w !== '&') words.pop();
      if (i >= words.length) continue;
      const nameWords = words.slice(i);
      if (isAmbiguous(m[2]) && (nameWords.length === 0 || !/^\p{Lu}\p{Ll}/u.test(nameWords[nameWords.length - 1].w))) continue;
      if (nameWords.every((x) => x.w === '&' || x.w.length < 2)) continue;
      if (nameWords.length === 1 && nameWords[0].w.length < 3) continue;
      const start = g[0] + nameWords[0].at;
      const end = sg[1]; // a trailing "." after Ltd/Inc/Corp/Co is usually the end of the sentence: left out
      out.push(mkHit(ID, 'ORG', start, end, 0.84, `name ending in the legal form '${m[2]}'`, 2, 'legal-suffix'));
      const base = t.slice(start, g[0] + nameWords[nameWords.length - 1].at + nameWords[nameWords.length - 1].w.length);
      if (nameWords.length >= 2 || base.length >= 8) stripped.set(base, 0.74);
    }
    ctx.check();
    // the same organization without its suffix elsewhere in the text
    if (stripped.size) {
      const names = [...stripped.keys()].sort((a, b) => b.length - a.length).slice(0, 200);
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`, 'gud');
      for (const m of matchAll(re, t)) out.push(mkHit(ID, 'ORG', m.index, m.index + m[0].length, 0.74, 'same organization name as one with a legal suffix elsewhere in this text', 2, 'org-propagated'));
    }
    return out;
  },
};
