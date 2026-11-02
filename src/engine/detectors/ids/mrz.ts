import type { IdPack } from './types';

const value = (c: string) => (c === '<' ? 0 : c <= '9' ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55);

/** ICAO 9303 check digit: character values weighted 7, 3, 1, sum modulo 10. */
export function mrzCheck(field: string): number {
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += value(field[i]) * [7, 3, 1][i % 3];
  return sum % 10;
}

/** Fields with a check digit per layout: [line, start, end, position of the check digit]. */
const LAYOUTS: Record<'TD1' | 'TD2' | 'TD3', { len: number; checks: [number, number, number, number][] }> = {
  // ID cards: document number on line 1, birth and expiry dates on line 2
  TD1: { len: 30, checks: [[0, 5, 14, 14], [1, 0, 6, 6], [1, 8, 14, 14]] },
  // older ID cards and visas, passports: document number, birth and expiry dates on line 2
  TD2: { len: 36, checks: [[1, 0, 9, 9], [1, 13, 19, 19], [1, 21, 27, 27]] },
  TD3: { len: 44, checks: [[1, 0, 9, 9], [1, 13, 19, 19], [1, 21, 27, 27]] },
};

/**
 * Machine-readable zone of passports and ID cards (two or three lines of A-Z, 0-9 and '<'). It holds
 * the name, document number, nationality and date of birth, so the whole zone is masked.
 */
export const mrz: IdPack = {
  id: 'mrz',
  label: 'Passport / ID machine-readable zone (MRZ)',
  type: 'MRZ',
  // OCR may put spaces between runs of '<'; lines are bounded, so this stays linear
  re: /(?<![A-Z0-9<])[A-Z0-9<][A-Z0-9< ]{24,50}[A-Z0-9<](?:\r?\n[A-Z0-9<][A-Z0-9< ]{24,50}[A-Z0-9<]){1,2}(?![A-Z0-9<])/g,
  validate(m, _cue, ocr) {
    const lines = m[0].split(/\r?\n/).map((l) => l.replace(/ /g, ''));
    if ((m[0].match(/</g) ?? []).length < 4 || !/^[ACIPV][A-Z<]/.test(lines[0])) return null;
    const layout = lines.length === 3 ? 'TD1' : lines[0].length > 40 ? 'TD3' : 'TD2';
    const L = LAYOUTS[layout];
    let valid = 0;
    if (lines.every((l) => l.length === L.len)) {
      for (const [line, s, e, c] of L.checks) if (/\d/.test(lines[line][c]) && mrzCheck(lines[line].slice(s, e)) === +lines[line][c]) valid++;
    }
    if (valid === L.checks.length) return { conf: 0.97, reason: `machine-readable zone of a passport or ID card (${layout}, check digits valid)` };
    // OCR misreads a character now and then: MRZ-shaped lines of about the right length still count
    if (ocr && lines.every((l) => Math.abs(l.length - L.len) <= 3)) {
      return { conf: 0.78, reason: `machine-readable zone of a passport or ID card (read by OCR; ${valid} of ${L.checks.length} check digits valid)` };
    }
    return null;
  },
};
