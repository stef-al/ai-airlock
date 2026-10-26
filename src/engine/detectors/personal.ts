import { GENERIC_USERS } from '../data/words';
import { SENS_RANK, type Detector, type Hit } from '../types';
import { ci, groupSpan, matchAll } from '../util';
import { mkHit } from './helpers';

// ---------------------------------------------------------------------------------------------
// user names in file paths
// ---------------------------------------------------------------------------------------------

const UNIX = /(?<![\w.~-])(?:\/home|\/Users|\/export\/home)\/([A-Za-z0-9][A-Za-z0-9._-]{1,31})(?=[/\\\s"'`):,;]|$)/gd;
// brackets are left out of the name: "(see C:\Users\jdoe)" must not take the ")"
const WIN = /(?<!\w)[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+([^\\/:*?"<>|\r\n\s%$,;()[\]{}]{2,32})(?=[\\/\s"'`)\]}:,;.]|$)/gid;

export const usernameDetector: Detector = {
  id: 'paths.username',
  label: 'User names inside file paths (/home/jsmith, C:\\Users\\jsmith)',
  category: 'personal',
  types: ['USERNAME'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, cfg) {
    if (SENS_RANK[cfg.sensitivity] < SENS_RANK.balanced) return [];
    const out: Hit[] = [];
    for (const re of [UNIX, WIN]) {
      for (const m of matchAll(re, doc.text)) {
        const g = groupSpan(m, 1)!;
        const name = m[1].replace(/[.,;]+$/, '');
        // /home/example.js is a file, not a user directory
        if (/\.[A-Za-z0-9]{1,5}$/.test(name) && !/^[/\\]/.test(doc.text.slice(g[1], g[1] + 1))) continue;
        if (GENERIC_USERS.has(name.toLowerCase()) || /^[<{$%[]/.test(name) || /^\.+$/.test(name)) continue;
        out.push(mkHit('paths.username', 'USERNAME', g[0], g[0] + name.length, 0.85, 'user name in a home-directory path', 2, 'path-user'));
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// dates of birth
// ---------------------------------------------------------------------------------------------

const CUES = [
  'date of birth', 'birth date', 'birthdate', 'birthday', 'dob', 'd.o.b.', 'd.o.b', 'born on', 'born', 'geburtsdatum', 'geburtstag', 'geboren am', 'geboren', 'geb.',
  'né le', 'née le', 'date de naissance', 'naissance', 'fecha de nacimiento', 'nacimiento', 'nacido el', 'nacida el', 'data di nascita', 'nato il', 'nata il',
  'data urodzenia', 'urodzony', 'urodzona', 'ur.', 'datum narození', 'narozen', 'narozena',
];
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, 'mär': 3, apr: 4, may: 5, mai: 5, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12, 'déc': 12,
  'fév': 2, avr: 4, juin: 6, juil: 7, 'aoû': 8, ene: 1, abr: 4, ago: 8, set: 9, dic: 12, gen: 1, mag: 5, giu: 6, lug: 7, ott: 10,
};
const monthOf = (w: string): number | null => {
  const k = w.toLowerCase().replace(/\.$/, '');
  if (MONTHS[k]) return MONTHS[k];
  const k3 = k.slice(0, 3);
  return k.length >= 3 && MONTHS[k3] && /^[a-zà-ž]+$/.test(k) ? MONTHS[k3] : null;
};
const alt = [...CUES].sort((a, b) => b.length - a.length).map(ci).join('|');
const NUM = String.raw`\d{1,2}[./-]\d{1,2}[./-](?:19|20)?\d{2}`;
const ISO = String.raw`(?:19|20)\d{2}-\d{1,2}-\d{1,2}`;
const DMY = String.raw`\d{1,2}(?:st|nd|rd|th|\.)?[ \t]+[A-Za-zÀ-ž]{3,10}\.?,?[ \t]+(?:19|20)\d{2}`;
const MDY = String.raw`[A-Za-zÀ-ž]{3,10}\.?[ \t]+\d{1,2}(?:st|nd|rd|th)?,?[ \t]+(?:19|20)\d{2}`;
const DATE = `(?:${ISO}|${NUM}|${DMY}|${MDY})`;
const RE_DOB = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}])(?:[ \\t]+[\\p{L}.']{1,14}){0,3}?[ \\t]*(?:\\([^)\\n]{0,12}\\))?[ \\t]*(?:[:=]|[-–]|[ \\t]+(?:is|was|ist|est|es|è|je|on|am|el|il|le)\\b)?[ \\t]*["']?(${DATE})`, 'gud');
const DATE_ONLY = new RegExp(`^${DATE}$`, 'u');
const DOB_KEY = /(?:^|[_\s-])(?:dob|birth(?:day|date)?|born|geburtsdatum|geburtstag|naissance|nacimiento|nascita|urodzenia|narozeni)(?:$|[_\s-])|date[_\s-]?of[_\s-]?birth|birth[_\s-]?date/i;

export function validDate(s: string): boolean {
  const now = new Date().getFullYear();
  let m: RegExpExecArray | null;
  let d = 0;
  let mo = 0;
  let y = 0;
  if ((m = /^((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
  } else if ((m = /^(\d{1,2})[./-](\d{1,2})[./-]((?:19|20)?\d{2})$/.exec(s))) {
    y = +m[3] < 100 ? (+m[3] > 30 ? 1900 + +m[3] : 2000 + +m[3]) : +m[3];
    const a = +m[1];
    const b = +m[2];
    // day-first or month-first: either reading may be valid
    if (b <= 12) {
      d = a;
      mo = b;
    } else {
      d = b;
      mo = a;
    }
    if (a > 12 && b > 12) return false;
  } else if ((m = /^(\d{1,2})(?:st|nd|rd|th|\.)?[ \t]+([A-Za-zÀ-ž]{3,10})\.?,?[ \t]+((?:19|20)\d{2})$/u.exec(s))) {
    d = +m[1];
    mo = monthOf(m[2]) ?? 0;
    y = +m[3];
  } else if ((m = /^([A-Za-zÀ-ž]{3,10})\.?[ \t]+(\d{1,2})(?:st|nd|rd|th)?,?[ \t]+((?:19|20)\d{2})$/u.exec(s))) {
    mo = monthOf(m[1]) ?? 0;
    d = +m[2];
    y = +m[3];
  } else return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > now) return false;
  const dim = new Date(y, mo, 0).getDate();
  return d <= dim;
}

export const dobDetector: Detector = {
  id: 'personal.dob',
  label: 'Dates of birth next to a birth cue (DOB, geboren, né le…)',
  category: 'personal',
  types: ['DOB'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, cfg) {
    if (SENS_RANK[cfg.sensitivity] < SENS_RANK.balanced) return [];
    const t = doc.text;
    const out: Hit[] = [];
    for (const m of matchAll(RE_DOB, t)) {
      const g = groupSpan(m, 1)!;
      if (!validDate(m[1])) continue;
      out.push(mkHit('personal.dob', 'DOB', g[0], g[1], 0.9, 'date next to a date-of-birth cue', 2, 'dob-cue'));
    }
    for (const p of doc.pairs) {
      if (!DOB_KEY.test(p.key)) continue;
      const v = t.slice(p.valStart, p.valEnd).trim();
      if (!DATE_ONLY.test(v) || !validDate(v)) continue;
      out.push(mkHit('personal.dob', 'DOB', p.valStart, p.valEnd, 0.9, `value of the key '${p.key}'`, 2, 'dob-key'));
    }
    return out;
  },
};
