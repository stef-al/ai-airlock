import { isPlaceholderValue, isReference } from '../cues';
import type { Column, Detector, Doc, Hit, Settings } from '../types';
import { escapeRegExp, segAt, skipEmpty } from '../util';
import { isEmail } from './contact';
import { cardBrand, ibanValid, luhn } from './financial';
import { analyzerFor, CAT_OF_TYPE, mkHit } from './helpers';
import { compileUserRegex, typeName } from '../userRegex';

// ---------------------------------------------------------------------------------------------
// always-mask lists
// ---------------------------------------------------------------------------------------------

const LETTER = /[\p{L}\p{N}]/u;

function boundaryOk(text: string, s: number, e: number, identifier: boolean): boolean {
  const pre = s > 0 ? text[s - 1] : '';
  const post = e < text.length ? text[e] : '';
  if (!identifier) return !(pre && LETTER.test(pre)) && !(post && LETTER.test(post));
  // camelCase / snake_case humps: AcmeBankService, acme_bank_service
  const first = text[s];
  const last = text[e - 1];
  const preOk = !pre || !LETTER.test(pre) || (/\p{Ll}|\p{N}/u.test(pre) && /\p{Lu}/u.test(first));
  const postOk = !post || !LETTER.test(post) || (/\p{Lu}/u.test(post) && /\p{Ll}|\p{N}/u.test(last)) || (/\p{N}/u.test(post) && false);
  return preOk && postOk;
}

function termToSource(term: string): string {
  const words = term.trim().split(/[\s_\-]+/).filter(Boolean);
  return words.map(escapeRegExp).join('[\\s_\\-]*');
}

interface Compiled {
  re: RegExp;
  type: string;
  list: string;
}

const listCache = new Map<string, Compiled[]>();

/** FNV-1a over every term, so an edit anywhere in a long list invalidates the cache */
function termsHash(terms: string[]): number {
  let h = 2166136261;
  for (const t of terms) {
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 10, 16777619);
  }
  return h >>> 0;
}

function compileLists(s: Settings): Compiled[] {
  const key = JSON.stringify(s.customLists.map((l) => [l.enabled, l.type, l.name, l.terms.length, termsHash(l.terms)]));
  const hit = listCache.get(key);
  if (hit) return hit;
  const out: Compiled[] = [];
  for (const l of s.customLists) {
    if (!l.enabled) continue;
    const terms = [...new Set(l.terms.map((t) => t.trim()).filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
    for (let i = 0; i < terms.length; i += 300) {
      const src = terms.slice(i, i + 300).map(termToSource).join('|');
      try {
        out.push({ re: new RegExp(`(?:${src})`, 'giud'), type: typeName(l.type), list: l.name });
      } catch {
        /* ignore malformed terms */
      }
    }
  }
  if (listCache.size > 6) listCache.clear();
  listCache.set(key, out);
  return out;
}

export const listsDetector: Detector = {
  id: 'custom.lists',
  label: 'Always-mask lists (clients, projects, products, employees…)',
  category: 'custom',
  types: ['CLIENT', 'PROJECT', 'PRODUCT', 'EMPLOYEE'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, _cfg, ctx) {
    const out: Hit[] = [];
    for (const c of compileLists(ctx.settings)) {
      c.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = c.re.exec(doc.text))) {
        if (m[0].length === 0) {
          skipEmpty(c.re, doc.text);
          continue;
        }
        if (++n > 50000) break;
        const seg = segAt(doc, m.index);
        const ident = seg?.scope === 'identifier' || seg?.scope === 'key';
        if (!boundaryOk(doc.text, m.index, m.index + m[0].length, !!ident)) continue;
        out.push({
          ...mkHit('custom.lists', c.type, m.index, m.index + m[0].length, 0.99, `listed in your always-mask list '${c.list}'`, 4, 'list', CAT_OF_TYPE[c.type] ?? 'custom'),
        });
      }
      ctx.check();
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// user regex rules
// ---------------------------------------------------------------------------------------------

export const regexDetector: Detector = {
  id: 'custom.regex',
  label: 'Your regex rules',
  category: 'custom',
  types: ['CUSTOM'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, _cfg, ctx) {
    const out: Hit[] = [];
    for (const r of ctx.settings.regexRules) {
      if (!r.enabled) continue;
      const re = compileUserRegex(r.pattern, r.flags);
      if (typeof re === 'string') continue;
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = re.exec(doc.text))) {
        if (m[0].length === 0) {
          skipEmpty(re, doc.text);
          continue;
        }
        if (++n > 20000) break;
        const g = (m as RegExpExecArray & { indices?: [number, number][] }).indices?.[1];
        const s = g ? g[0] : m.index;
        const e = g ? g[1] : m.index + m[0].length;
        if (e > s) out.push(mkHit('custom.regex', typeName(r.type), s, e, 0.95, `matches your rule '${r.name}'`, 4, 'regex:' + r.id));
      }
      ctx.check();
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// columns (CSV / Markdown tables)
// ---------------------------------------------------------------------------------------------

const CLIENT_H = /customer|client|company|organi[sz]ation|firma|kunde|soci[eé]t[eé]|cliente|klient|z[áa]kazn[ií]k|employer|business name|account name/i;
const PERSON_H = /full[\s_-]?name|first[\s_-]?name|last[\s_-]?name|sur[\s_-]?name|given[\s_-]?name|family[\s_-]?name|employee|contact[\s_-]?(?:person|name)|person|author|assignee|reporter|vorname|nachname|pr[ée]nom|apellido|imi[eę]|nazwisko|jm[ée]no|p[řr][ií]jmen[ií]|owner/i;
const PHONE_H = /phone|^tel\b|telefon|mobile|handy|\bfax\b|t[ée]l[ée]phone|tel[ée]fono|\bcell\b/i;
const EMAIL_H = /e-?mail|courriel|correo|^mail$/i;
const IBAN_H = /\biban\b/i;
const CARD_H = /card[\s_-]?(?:number|no|num)|credit[\s_-]?card|\bcc[\s_-]?(?:number|num|no)\b|\bpan\b|kreditkarte|carte bancaire/i;
const DOB_H = /birth|\bdob\b|geburt|naissance|nacimiento|nascita|urodzen|narozen/i;
const CVV_H = /\b(?:cvv2?|cvc2?|csc)\b/i;
const PERSONISH = /^\p{Lu}[\p{L}'.-]+(?:\s+\p{Lu}[\p{L}'.-]+){0,3}$/u;
const EMPTY_CELL = /^(?:-+|n\/?a|null|none|nil|tbd|\?+|—|–|)$/i;

export function classifyColumn(col: Column, text: string, settings: Settings): { type: string; conf: number; why: string } | null {
  const h = col.header.trim();
  const sample = col.cells.slice(0, 200).map((c) => text.slice(c.start, c.end).trim()).filter((v) => v && !EMPTY_CELL.test(v));
  const frac = (f: (v: string) => boolean) => (sample.length ? sample.filter(f).length / sample.length : 0);
  if (sample.length === 0) return null;
  if (EMAIL_H.test(h)) return { type: 'EMAIL', conf: 0.93, why: 'header' };
  if (IBAN_H.test(h)) return { type: 'IBAN', conf: 0.93, why: 'header' };
  if (DOB_H.test(h)) return { type: 'DOB', conf: 0.9, why: 'header' };
  if (CVV_H.test(h)) return { type: 'CVV', conf: 0.93, why: 'header' };
  if (CARD_H.test(h)) return { type: 'CARD', conf: 0.93, why: 'header' };
  const ki = analyzerFor(settings).analyze(h);
  if (ki && !ki.negated && ki.strength !== 'weak') return { type: ki.type, conf: 0.92, why: 'header' };
  if (PHONE_H.test(h)) return { type: 'PHONE', conf: 0.9, why: 'header' };
  if (CLIENT_H.test(h)) return { type: 'CLIENT', conf: 0.9, why: 'header' };
  if (PERSON_H.test(h)) return { type: 'PERSON', conf: 0.9, why: 'header' };
  if (/^(?:name|nom|nombre|nazwa|jméno|contact|kontakt|contacto|ansprechpartner(?:in)?)$/i.test(h) && frac((v) => PERSONISH.test(v)) >= 0.7 && sample.length >= 2) return { type: 'PERSON', conf: 0.75, why: 'header "name" and person-like values' };
  if (sample.length >= 2) {
    if (frac(isEmail) >= 0.7) return { type: 'EMAIL', conf: 0.85, why: 'values' };
    if (frac(ibanValid) >= 0.7) return { type: 'IBAN', conf: 0.9, why: 'values' };
    if (frac((v) => luhn(v.replace(/\D/g, '')) && !!cardBrand(v.replace(/\D/g, ''))) >= 0.7) return { type: 'CARD', conf: 0.88, why: 'values' };
  }
  return null;
}

export const columnsDetector: Detector = {
  id: 'custom.columns',
  label: 'Table columns (CSV / Markdown) by header and values',
  category: 'custom',
  types: ['EMAIL', 'PHONE', 'PASSWORD', 'CLIENT', 'PERSON', 'DOB'],
  defaultScopes: ['prose', 'config', 'string'],
  detect(doc: Doc, _cfg, ctx) {
    const out: Hit[] = [];
    for (const col of doc.columns) {
      const k = classifyColumn(col, doc.text, ctx.settings);
      if (!k) continue;
      for (const c of col.cells) {
        const v = doc.text.slice(c.start, c.end);
        if (!v.trim() || EMPTY_CELL.test(v.trim()) || isPlaceholderValue(v.trim()) || isReference(v.trim())) continue;
        const lead = v.length - v.trimStart().length;
        out.push(mkHit('custom.columns', k.type, c.start + lead, c.end - (v.length - v.trimEnd().length), k.conf, `column '${col.header}' is classified as ${k.type} (${k.why})`, 2, 'column'));
      }
    }
    return out;
  },
};
