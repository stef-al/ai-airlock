import type { Mapping } from './placeholders';
import { escapeRegExp } from './util';

export interface RestoreReport {
  output: string;
  /** placeholder id -> number of occurrences put back */
  restored: { id: string; count: number }[];
  /** placeholder-looking tokens that are not in the mapping (invented or from another session) */
  unknown: string[];
  /** ids that were expected in the reply but never appeared */
  missing: string[];
  total: number;
}

export const KNOWN_TYPES = new Set(
  ('PASSWORD SECRET TOKEN API_KEY PIN JWT PRIVATE_KEY PASSWORD_HASH COOKIE EMAIL PHONE PERSON ORG DOB SSN NATIONAL_ID USERNAME ' +
    'IBAN CARD CVV CARD_EXPIRY IP IPV6 MAC HOST CLIENT PROJECT PRODUCT EMPLOYEE CUSTOM')
    .split(' ')
    .map((t) => t.replace(/_/g, '')),
);

/** Case-insensitive literal without the i flag (so [a-z] lookaheads stay case-sensitive). */
const ci = (s: string) => escapeRegExp(s).replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

const BRACKET = String.raw`\[\s*([A-Za-z]+(?:_[A-Za-z]+)*?)[_\-\s]?(\d{1,6})\s*\]`;
const BARE = String.raw`(?:(?<![A-Za-z0-9_])|(?<=[a-z0-9])(?=[A-Z]))([A-Za-z]+(?:_[A-Za-z]+)*?)[_-]?(\d{1,6})(?![0-9])(?![a-z])`;

/**
 * Put originals back. Tolerates what chatbots do to placeholders: dropped or changed brackets,
 * backticks around them, different case, hyphen instead of underscore, fake emails in other case.
 */
export function restoreText(text: string, mapping: Mapping, expected?: Iterable<string>): RestoreReport {
  const counts = new Map<string, number>();
  const unknown = new Set<string>();
  const fakes = mapping.fakeList().sort((a, b) => b.length - a.length);
  const knownTypes = new Set(KNOWN_TYPES);
  for (const e of mapping.entries()) knownTypes.add(e.type.replace(/_/g, ''));
  const fakeAlt = fakes.length ? `(?<![\\w@.+-])(${fakes.map(ci).join('|')})(?![\\w@-]|\\.\\d)` : '(?!)()';
  const re = new RegExp(`${fakeAlt}|${BRACKET}|${BARE}`, 'g');
  let total = 0;
  const output = text.replace(re, (m: string, fake?: string, bl?: string, bn?: string, rl?: string, rn?: string) => {
    if (fake) {
      const e = mapping.lookupFake(fake);
      if (!e) return m;
      counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
      total++;
      return e.original;
    }
    const letters = bl ?? rl;
    const num = bn ?? rn;
    if (!letters || !num) return m;
    const e = mapping.lookupNorm(letters, num);
    if (e) {
      counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
      total++;
      return e.original;
    }
    if (bl === undefined) {
      // glued to a lowercase prefix: -pPASSWORD_2, getClient1Service
      for (const h of letters.matchAll(/(?<=[a-z0-9])(?=[A-Z])/g)) {
        const e2 = mapping.lookupNorm(letters.slice(h.index), num);
        if (e2) {
          counts.set(e2.id, (counts.get(e2.id) ?? 0) + 1);
          total++;
          return letters.slice(0, h.index) + e2.original;
        }
      }
    }
    const norm = letters.toUpperCase().replace(/_/g, '');
    const looksTyped = knownTypes.has(norm) && (bl !== undefined || (letters === letters.toUpperCase() && letters.includes('_')) || letters === letters.toUpperCase());
    if (looksTyped) unknown.add(bl !== undefined ? `[${letters.toUpperCase()}_${num}]` : `${letters.toUpperCase()}_${num}`);
    return m;
  });
  const missing: string[] = [];
  if (expected) for (const id of expected) if (!counts.has(id)) missing.push(id);
  return {
    output,
    restored: [...counts].map(([id, count]) => ({ id, count })),
    unknown: [...unknown],
    missing,
    total,
  };
}
