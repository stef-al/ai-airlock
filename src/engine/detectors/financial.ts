import { SENS_RANK, type Detector, type Hit } from '../types';
import { lineBounds } from '../util';
import { mkHit } from './helpers';

const IBAN_LEN: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28,
  CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18,
  GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24,
  PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  const len = IBAN_LEN[s.slice(0, 2)];
  if (!len || s.length !== len || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    rem = v > 9 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem === 1;
}

export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const BRANDS: { name: string; re: RegExp; lens: number[] }[] = [
  { name: 'Visa', re: /^4/, lens: [13, 16, 19] },
  { name: 'Mastercard', re: /^(?:5[1-5]|2(?:2[2-9][1-9]|2[3-9]|[3-6]\d|7[01]|720))/, lens: [16] },
  { name: 'American Express', re: /^3[47]/, lens: [15] },
  { name: 'Discover', re: /^(?:6011|65|64[4-9]|622(?:12[6-9]|1[3-9]|[2-8]|9[01]|92[0-5]))/, lens: [16, 17, 18, 19] },
  { name: 'Diners Club', re: /^(?:36|38|39|30[0-5])/, lens: [14, 16, 19] },
  { name: 'JCB', re: /^35(?:2[89]|[3-8])/, lens: [16, 17, 18, 19] },
  { name: 'UnionPay', re: /^62/, lens: [16, 17, 18, 19] },
  { name: 'Maestro', re: /^(?:50|5[6-9]|6\d)/, lens: [12, 13, 14, 15, 16, 17, 18, 19] },
];

export function cardBrand(digits: string): string | null {
  for (const b of BRANDS) if (b.re.test(digits) && b.lens.includes(digits.length)) return b.name;
  return null;
}

const IBAN_RE = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]{4}){2,7}(?:[ -]?[A-Za-z0-9]{1,4})?(?![A-Za-z0-9])/g;
const CARD_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
const CARD_CUE = /(?:card|visa|master\s?card|amex|cc|pan|credit|debit|kredit|karte|carte|tarjeta|carta|payment|zahlung|paiement|karta|platební)\b[\s\w#:.=-]{0,16}$/i;
const CVV_RE = /\b(?:cvv2?|cvc2?|csc|cid|card verification(?: value| code)?|security code|sicherheitscode|prüfziffer|pruefziffer|cryptogramme|c[oó]digo de seguridad|kod bezpiecze[nń]stwa)["']?\s*[:=#]?\s*["']?(\d{3,4})\b/gi;
const EXP_RE = /\b(?:exp(?:iry|iration|ires?)?(?:\s*date)?|valid\s*(?:thru|until|through)|g[üu]ltig\s*bis|expire[sd]?)["']?\s*[:=#]?\s*["']?((?:0[1-9]|1[0-2])\s*[/-]\s*(?:\d{2}|20\d{2}))\b/gi;

export const ibanDetector: Detector = {
  id: 'financial.iban',
  label: 'IBAN (mod-97 checked)',
  category: 'financial',
  types: ['IBAN'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc) {
    const out: Hit[] = [];
    const text = doc.text;
    IBAN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IBAN_RE.exec(text))) {
      let cand = m[0];
      // the greedy group match may swallow trailing words; try shrinking to a valid length
      let ok = ibanValid(cand);
      if (!ok) {
        const compact = cand.replace(/[\s-]/g, '');
        const len = IBAN_LEN[compact.slice(0, 2).toUpperCase()];
        if (len && compact.length > len) {
          let count = 0;
          let cut = 0;
          for (let i = 0; i < cand.length; i++) {
            if (!/[\s-]/.test(cand[i])) count++;
            if (count === len) {
              cut = i + 1;
              break;
            }
          }
          if (cut && ibanValid(cand.slice(0, cut))) {
            cand = cand.slice(0, cut);
            ok = true;
          }
        }
      }
      if (!ok) continue;
      out.push(mkHit('financial.iban', 'IBAN', m.index, m.index + cand.length, 0.99, `IBAN with valid mod-97 checksum (${cand.slice(0, 2).toUpperCase()})`, 3, 'iban'));
    }
    return out;
  },
};

export const cardDetector: Detector = {
  id: 'financial.card',
  label: 'Payment cards (Luhn) with CVV / expiry',
  category: 'financial',
  types: ['CARD', 'CVV', 'CARD_EXPIRY'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, cfg) {
    const out: Hit[] = [];
    const text = doc.text;
    const rank = SENS_RANK[cfg.sensitivity];
    const cards: Hit[] = [];
    CARD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CARD_RE.exec(text))) {
      const raw = m[0];
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) continue;
      if (/^(\d)\1+$/.test(digits)) continue;
      if (!luhn(digits)) continue;
      const brand = cardBrand(digits);
      if (!brand) continue;
      const grouped = /[ -]/.test(raw);
      const [ls] = lineBounds(text, m.index);
      const cue = CARD_CUE.test(text.slice(Math.max(ls, m.index - 40), m.index));
      if (!grouped && !cue && rank < 2) continue;
      const h = mkHit('financial.card', 'CARD', m.index, m.index + raw.length, cue ? 0.98 : grouped ? 0.92 : 0.7, `${brand} card number (Luhn valid, ${digits.length} digits)`, 3, 'card');
      cards.push(h);
      out.push(h);
    }
    const near = (pos: number) => cards.some((c) => Math.abs(c.start - pos) < 250);
    CVV_RE.lastIndex = 0;
    while ((m = CVV_RE.exec(text))) {
      const s = m.index + m[0].lastIndexOf(m[1]);
      out.push(mkHit('financial.card', 'CVV', s, s + m[1].length, 0.9, 'card security code (CVV/CVC)', 3, 'cvv'));
    }
    EXP_RE.lastIndex = 0;
    while ((m = EXP_RE.exec(text))) {
      const s = m.index + m[0].lastIndexOf(m[1]);
      const win = text.slice(Math.max(0, s - 120), s + 120);
      if (!near(s) && !/card|karte|carte|tarjeta|cvv|cvc/i.test(win)) continue;
      out.push(mkHit('financial.card', 'CARD_EXPIRY', s, s + m[1].length, 0.85, 'card expiry date next to a card', 3, 'card-expiry'));
    }
    return out;
  },
};
