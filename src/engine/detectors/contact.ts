import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { SENS_RANK, type Detector, type Hit } from '../types';
import { lineBounds } from '../util';
import { mkHit } from './helpers';

const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9_][A-Za-z0-9._%+-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;
const FILE_TLD = new Set('png jpg jpeg gif svg webp ico bmp css js mjs ts tsx jsx json html htm xml woff woff2 ttf eot map md txt pdf zip gz tar'.split(' '));
const URL_CRED_BEFORE = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:$/i;

export const EMAIL_RE_SOURCE = EMAIL.source;
export function isEmail(s: string): boolean {
  return new RegExp('^' + EMAIL.source + '$').test(s);
}

export const emailDetector: Detector = {
  id: 'contact.email',
  label: 'Email addresses',
  category: 'personal',
  types: ['EMAIL'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc) {
    const text = doc.text;
    const out: Hit[] = [];
    if (!text.includes('@')) return out;
    EMAIL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMAIL.exec(text))) {
      const s = m.index;
      const e = s + m[0].length;
      const tld = m[0].slice(m[0].lastIndexOf('.') + 1).toLowerCase();
      if (FILE_TLD.has(tld)) continue;
      const local = m[0].slice(0, m[0].indexOf('@'));
      // scp-style git remotes: git@github.com:org/repo.git
      if (local === 'git' && text[e] === ':' && !/\d/.test(text[e + 1] ?? '')) continue;
      if (URL_CRED_BEFORE.test(text.slice(Math.max(0, s - 120), s))) continue;
      out.push(mkHit('contact.email', 'EMAIL', s, e, 0.97, 'email address', 2, 'email'));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// phone numbers
// ---------------------------------------------------------------------------------------------

const PHONE_CAND = /(?<![\w.+/-])(?:\+|00)?\(?\d[\d\s().-]{5,22}\d(?![\w-]|\.\d)/g;
const PHONE_CUE = /(?:tel(?:ephone|efon|éfono|efono)?|phone|mobile|mob\.?|cell|fax|call|handy|whatsapp|téléphone|telefono|teléfono|telefon|kontakt|contact|rufnummer|numéro|numero|número|phone number|kom[óo]rka|mobil)\b[\s:.#=-]{0,6}$/i;
const DATE_LIKE = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$|^\d{1,2}[:.]\d{2}[:.]\d{2}/;
const IP_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function regionFromLocale(loc?: string): string {
  const l = loc ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  const m = /[-_]([A-Za-z]{2})\b/.exec(l ?? '');
  return (m ? m[1] : 'US').toUpperCase();
}

export const phoneDetector: Detector = {
  id: 'contact.phone',
  label: 'Phone numbers',
  category: 'personal',
  types: ['PHONE'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, cfg, ctx) {
    const text = doc.text;
    const out: Hit[] = [];
    const rank = SENS_RANK[cfg.sensitivity];
    const region = (ctx.settings.region || 'US') as CountryCode;
    PHONE_CAND.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = PHONE_CAND.exec(text))) {
      if (++n > 100000) break;
      let cand = m[0];
      let s = m.index;
      // trim trailing separators
      const trimmed = cand.replace(/[\s.()-]+$/, '');
      cand = trimmed;
      const digits = cand.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) continue;
      if (DATE_LIKE.test(cand) || IP_LIKE.test(cand)) continue;
      const intl = /^(?:\+|00)/.test(cand);
      const hasSep = /[\s().-]/.test(cand);
      // short dotted groups are almost always versions / IPs / decimals
      if (!intl && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(cand)) continue;
      const [ls] = lineBounds(text, s);
      const before = text.slice(Math.max(ls, s - 28), s);
      const cue = PHONE_CUE.test(before);
      if (!intl && !hasSep && !cue && rank < 2) continue;
      if (!intl && !cue && !hasSep) continue;
      if (!intl && !cue && rank < 1) continue;
      let pn = parsePhoneNumberFromString(cand, region);
      if (!pn && cand.startsWith('00')) pn = parsePhoneNumberFromString('+' + cand.slice(2));
      if (!pn || !pn.isValid()) continue;
      // national numbers without separators and cue are too ambiguous for balanced
      if (!intl && !hasSep && !cue) continue;
      const conf = intl ? 0.93 : cue ? 0.85 : 0.72;
      out.push(mkHit('contact.phone', 'PHONE', s, s + cand.length, conf, `phone number valid for ${pn.country ?? region}${intl ? ' (international format)' : cue ? ' (next to a phone label)' : ''}`, 2, 'phone'));
    }
    return out;
  },
};
