import { digitsOf, validYmd, type IdPack } from './types';

const KNOWN_BAD_SSN = new Set(['078051120', '219099999', '457555462']);

export const usSsn: IdPack = {
  id: 'us-ssn',
  label: 'US Social Security number',
  type: 'SSN',
  re: /(?<![\d-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\d-])|(?<!\d)(\d{9})(?!\d)/g,
  cue: /(?:ssn|social security(?: number)?|soc\.? sec\.?|ss#)[\s:#=.-]{0,6}$/i,
  validate(m, cue) {
    const d = digitsOf(m[0]);
    const formatted = m[5] === undefined;
    if (!formatted && !cue) return null;
    const area = +d.slice(0, 3);
    if (area === 0 || area === 666 || area >= 900 || d.slice(3, 5) === '00' || d.slice(5) === '0000' || KNOWN_BAD_SSN.has(d)) return null;
    return { conf: cue ? 0.96 : 0.88, reason: `US Social Security number format${cue ? ' next to an SSN label' : ''}` };
  },
};

const NINO_BAD = new Set(['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ']);
export const ukNino: IdPack = {
  id: 'uk-nino',
  label: 'UK National Insurance number',
  type: 'NINO',
  re: /(?<![A-Za-z0-9])([A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z])([ ]?)(\d{2})\2(\d{2})\2(\d{2})\2([A-D])(?![A-Za-z0-9])/g,
  cue: /(?:national insurance(?: number)?|nino|ni number|ni no\.?)[\s:#=.-]{0,6}$/i,
  validate(m, cue) {
    if (NINO_BAD.has(m[1])) return null;
    return { conf: cue || m[2] ? 0.92 : 0.82, reason: 'UK National Insurance number format' };
  },
};

function czDateOk(yy: number, mm: number, dd: number, digits: number): boolean {
  let month = mm;
  if (month > 70) month -= 70;
  else if (month > 50) month -= 50;
  else if (month > 20 && month < 33) month -= 20;
  if (month < 1 || month > 12) return false;
  const year = digits === 9 ? 1900 + yy : yy >= 54 ? 1900 + yy : 2000 + yy;
  return validYmd(year, month, dd) && year <= new Date().getFullYear();
}

export const czSkBirthNumber: IdPack = {
  id: 'cz-sk-birth-number',
  label: 'Czech / Slovak birth number (rodné číslo)',
  type: 'BIRTH_NUMBER',
  re: /(?<![\d/])(\d{2})(\d{2})(\d{2})(\/?)(\d{3,4})(?![\d/])/g,
  cue: /(?:rodn[ée] [čc][ií]slo|r\.?[čc]\.?|birth number|rc)[\s:#=.-]{0,6}$/i,
  validate(m, cue) {
    const tail = m[5];
    const digits = 6 + tail.length;
    if (!czDateOk(+m[1], +m[2], +m[3], digits)) return null;
    if (digits === 9) {
      // pre-1954 numbers carry no checksum: demand a slash or a cue
      if (!m[4] && !cue) return null;
      return { conf: cue ? 0.9 : 0.8, reason: 'Czech/Slovak birth number (9 digits, valid date)' };
    }
    const n = Number(m[1] + m[2] + m[3] + tail.slice(0, 3));
    const last = Number(tail[3]);
    const mod = n % 11;
    const ok = mod === last || (mod === 10 && last === 0);
    if (!ok) return null;
    return { conf: m[4] || cue ? 0.94 : 0.8, reason: 'Czech/Slovak birth number (valid date and mod-11 checksum)' };
  },
};

export const plPesel: IdPack = {
  id: 'pl-pesel',
  label: 'Polish PESEL',
  type: 'PESEL',
  re: /(?<![\d.])(\d{11})(?![\d.])/g,
  cue: /(?:pesel|nr pesel|numer pesel)[\s:#=.-]{0,6}$/i,
  validate(m, cue) {
    const d = m[1];
    const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
    const sum = w.reduce((a, x, i) => a + x * +d[i], 0);
    if ((10 - (sum % 10)) % 10 !== +d[10]) return null;
    let month = +d.slice(2, 4);
    let year = 1900 + +d.slice(0, 2);
    if (month > 80) {
      year -= 100;
      month -= 80;
    } else if (month > 60) {
      year += 300;
      month -= 60;
    } else if (month > 40) {
      year += 200;
      month -= 40;
    } else if (month > 20) {
      year += 100;
      month -= 20;
    }
    if (!validYmd(year, month, +d.slice(4, 6)) || year > new Date().getFullYear()) return null;
    return { conf: cue ? 0.96 : 0.82, reason: 'Polish PESEL (valid date and checksum)' };
  },
};
