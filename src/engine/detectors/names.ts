import { COMMON, FUNC_STOP, ROLE_LOCALS } from '../data/words';
import { FIRST_NAMES, LAST_NAMES } from '../data/names.generated';
import { SENS_RANK, type Detector, type Doc, type Hit } from '../types';
import { ci, escapeRegExp, groupSpan, matchAll } from '../util';
import { mkHit } from './helpers';

const ID = 'names.person';

let FIRST: Set<string> | null = null;
let LAST: Set<string> | null = null;
function lists() {
  FIRST ??= new Set(FIRST_NAMES.split('|'));
  LAST ??= new Set(LAST_NAMES.split('|'));
  return { FIRST, LAST };
}
const lc = (s: string) => s.toLowerCase();
const isFirst = (t: string) => lists().FIRST.has(lc(t));
const inLists = (t: string) => isFirst(t) || lists().LAST.has(lc(t));
const isCap = (t: string) => /^\p{Lu}/u.test(t);

// ---- building blocks --------------------------------------------------------------------------
const UP = '\\p{Lu}';
const LOW = '[\\p{Ll}\\p{M}]';
const WORD = `(?:[OD]['’])?${UP}${LOW}{1,30}(?:['’]?${UP}${LOW}{1,30}){0,3}(?:-${UP}${LOW}{1,30})?`;
const PART = '(?:de|del|della|di|da|do|dos|das|van|von|der|den|ten|ter|la|le|el|al|bin|ibn|zu|zur|af|av)';
/** 1 to 4 name tokens on one line */
const PHRASE = `${WORD}(?:[ \\t]+(?:${UP}\\.|(?:${PART}[ \\t]+)?${WORD})){0,3}`;
const alt = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length).map(ci).join('|');

const GREET = [
  'Hi there', 'Hello', 'Hi', 'Hey', 'Dear', 'Hallo', 'Liebe', 'Lieber', 'Liebes', 'Moin', 'Servus', 'Guten Tag', 'Guten Morgen', 'Guten Abend',
  'Bonjour', 'Bonsoir', 'Salut', 'Cher', 'Chère', 'Coucou', 'Hola', 'Estimado', 'Estimada', 'Querido', 'Querida', 'Buenos días', 'Buenas tardes',
  'Ciao', 'Caro', 'Cara', 'Gentile', 'Buongiorno', 'Salve', 'Egregio', 'Cześć', 'Witaj', 'Szanowny', 'Szanowna', 'Drogi', 'Droga', 'Dzień dobry',
  'Ahoj', 'Dobrý den', 'Vážený', 'Vážená', 'Milý', 'Milá', 'Dobré ráno', 'Beste', 'Hoi', 'Goedemorgen', 'Thanks', 'Thank you', 'Danke', 'Merci',
  'Gracias', 'Grazie', 'Dziękuję', 'Děkuji', 'Děkujeme', 'Cheers',
];
const SIGNOFF = [
  'Best regards', 'Kind regards', 'Warm regards', 'Regards', 'Best wishes', 'Best', 'Cheers', 'Thanks', 'Thank you', 'Many thanks', 'Sincerely',
  'Yours sincerely', 'Yours faithfully', 'Yours truly', 'Cordially', 'Viele Grüße', 'Beste Grüße', 'Freundliche Grüße', 'Mit freundlichen Grüßen',
  'Liebe Grüße', 'Herzliche Grüße', 'Schöne Grüße', 'Grüße', 'Gruß', 'MfG', 'VG', 'LG', 'Cordialement', 'Bien cordialement', 'Salutations',
  'Cordiales saludos', 'Saludos', 'Un saludo', 'Atentamente', 'Cordiali saluti', 'Distinti saluti', 'Saluti', 'Pozdrawiam', 'Z poważaniem',
  'Z pozdrowieniami', 'S pozdravem', 'S přáním', 'S úctou', 'Met vriendelijke groet', 'Groeten', 'Danke', 'Merci',
];
const HONORIFICS = [
  'Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Dr', 'Prof', 'Sir', 'Herr', 'Frau', 'Hr', 'Mme', 'Mlle', 'Monsieur', 'Madame', 'Sr', 'Sra', 'Srta', 'Don', 'Doña',
  'Dott', 'Dottor', 'Dottoressa', 'Avv', 'Pan', 'Pani', 'Pán', 'Paní', 'Mgr', 'JUDr', 'MUDr', 'Signor', 'Signora', 'Ing', 'Dipl-Ing',
];

const RE_GREET = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(GREET)})[ \\t]+(${PHRASE})`, 'gud');
const RE_HON = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(HONORIFICS)})\\.?[ \\t]+(?:(?:${alt(HONORIFICS)})\\.?[ \\t]+)*(${PHRASE})`, 'gud');
const RE_SIGN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(SIGNOFF)})[ \\t]*[,!.]?[ \\t]*\\r?\\n(?:[ \\t]*\\r?\\n)?[ \\t]*(${PHRASE})[ \\t]*(?=\\r?\\n|$)`, 'gud');
const RE_SIGN_INLINE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(SIGNOFF)})[ \\t]*,[ \\t]*(${WORD})[ \\t]*(?=[.!]?[ \\t]*(?:\\r?\\n|$))`, 'gud');
const STRONG_INTRO = ['my name is', "my name's", 'name is', 'ich heiße', 'mein Name ist', "je m'appelle", 'me llamo', 'mi nombre es', 'mi chiamo', 'nazywam się', 'jmenuji se'];
const WEAK_INTRO = ["I'm", 'I am', 'this is', 'ich bin', 'je suis', 'soy', 'sono', 'jestem', 'jsem'];
const RE_INTRO_STRONG = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(STRONG_INTRO)})[ \\t]+(${PHRASE})`, 'gud');
const RE_INTRO_WEAK = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(WEAK_INTRO)})[ \\t]+(${PHRASE})`, 'gud');
const LABELS = ['Owner', 'Author', 'Manager', 'Assignee', 'Reporter', 'Customer', 'Surname', 'First name', 'Last name', 'Vorname', 'Nachname', 'Full name', 'Name', 'Contact person', 'Contact', 'Customer name', 'Employee', 'Ansprechpartnerin', 'Ansprechpartner', 'Kontakt', 'Kunde', 'Mitarbeiterin', 'Mitarbeiter', 'Nom', 'Nombre', 'Imię i nazwisko', 'Jméno'];
const RE_LABEL = new RegExp(`(?<![\\p{L}\\p{N}])["']?(${alt(LABELS)})["']?[ \\t]*[:=][ \\t]*["']?(${PHRASE})(?=["']?[ \\t]*(?:[,;(}\\]]|\\r?\\n|$))`, 'gud');
const RE_HEADER = /^[ \t]*(?:From|To|Cc|Bcc|Reply-To|Sender|Von|An|Kopie|De|Para|Od|Komu|Da|À)[ \t]*:[ \t]*(.*)$/gimd;
const RE_DISPLAY = new RegExp(`(?:"([^"<>@\\n]{2,60})"|(?<![\\p{L}\\p{N}])(${PHRASE}))[ \\t]*<[^<>\\s]+@[^<>\\s]+>`, 'gud');
const RE_EMAIL = /(?<![\p{L}\p{N}._%+-])([\p{L}][\p{L}\p{N}_-]*(?:[._-][\p{L}][\p{L}\p{N}_-]*)+)@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const RE_CHAT = /^[ \t]*\[?\d{1,2}:\d{2}(?::\d{2})?\]?[ \t]*[-–]?[ \t]*<?([A-Za-z][\w.-]{1,24})>?:[ \t]/gmd;
const RE_PAIR = new RegExp(`(?<![\\p{L}\\p{N}])(${WORD})[ \\t]+(${WORD})(?![\\p{L}\\p{N}])`, 'gud');

const NAME_KEYS = /^(?:name|full[_ -]?name|fullname|first[_ -]?name|firstname|last[_ -]?name|lastname|surname|contact|contact[_ -]?name|owner|author|customer[_ -]?name|employee|assignee|reporter|manager|vorname|nachname|prenom|prénom)$/i;

interface Cand {
  s: number;
  e: number;
  conf: number;
  reason: string;
  rule: string;
}

/** Keep the leading tokens of a captured phrase that deserve to be masked. */
function trimPhrase(text: string, s: number, phrase: string, opts: { single: 'first' | 'any'; punct: boolean; needList?: boolean; listTail?: boolean }): { s: number; e: number } | null {
  const parts = [...phrase.matchAll(/\S+/gu)].map((m) => ({ t: m[0], at: m.index! }));
  const caps = parts.filter((p) => isCap(p.t));
  if (!caps.length) return null;
  if (FUNC_STOP.has(lc(caps[0].t.replace(/\.$/, '')))) return null;
  let last = 0;
  if (caps.length === 1 || parts.length === 1) {
    const t = caps[0].t;
    if (t.length < 3) return null;
    if (opts.single === 'first' && !(isFirst(t) && (!COMMON.has(lc(t)) || opts.punct))) return null;
    if (opts.single === 'any' && opts.needList && !inLists(t)) return null;
    last = parts.indexOf(caps[0]);
  } else {
    last = 0;
    for (let i = 1; i < parts.length; i++) {
      const t = parts[i].t;
      if (!isCap(t) && !new RegExp(`^${PART}$`).test(t) && !/^\p{Lu}\.$/u.test(t)) break;
      if (FUNC_STOP.has(lc(t))) break;
      if (opts.listTail) {
        // titles take a surname; further words only when they are known names (Dr. Anna von Berg, not "Dr. Alvarez von Lyon Logistique")
        const surnameOfFirst = i === 1 && isFirst(parts[0].t) && isCap(t);
        const nxt = new RegExp(`^${PART}$`).test(t) ? parts[i + 1]?.t : t;
        if (!surnameOfFirst && (!nxt || !(inLists(nxt) || /^\p{Lu}\.$/u.test(nxt)))) break;
      }
      if (opts.needList || !opts.punct) {
        if (!inLists(t) && !/^\p{Lu}\.$/u.test(t) && !opts.punct) break;
      }
      last = i;
    }
    // trailing particles are not part of the name
    while (last > 0 && new RegExp(`^${PART}$`).test(parts[last].t)) last--;
    if (opts.needList && !parts.slice(0, last + 1).some((p) => isCap(p.t) && inLists(p.t))) return null;
  }
  return { s: s + parts[0].at, e: s + parts[last].at + parts[last].t.length };
}

function derivedFromEmails(text: string): { first: string; last: string }[] {
  const out = new Map<string, { first: string; last: string }>();
  for (const m of matchAll(RE_EMAIL, text, 5000)) {
    const parts = m[1].split(/[._-]/).filter(Boolean);
    if (parts.length < 2 || parts.length > 3) continue;
    if (ROLE_LOCALS.has(lc(m[1])) || parts.some((p) => ROLE_LOCALS.has(lc(p)))) continue;
    if (parts.some((p) => p.length < 2 || /\d/.test(p))) continue;
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (!(inLists(first) || inLists(last))) continue;
    if (FUNC_STOP.has(lc(first)) || FUNC_STOP.has(lc(last))) continue;
    out.set(lc(first + ' ' + last), { first, last });
    if (out.size >= 300) break;
  }
  return [...out.values()];
}

export const personDetector: Detector = {
  id: ID,
  label: 'Person names (cues, lists, derived from emails)',
  category: 'personal',
  types: ['PERSON'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc: Doc, cfg, ctx) {
    const rank = SENS_RANK[cfg.sensitivity];
    if (rank < SENS_RANK.balanced) return [];
    const t = doc.text;
    const cands: Cand[] = [];
    const add = (s: number, e: number, conf: number, reason: string, rule: string) => {
      if (e > s) cands.push({ s, e, conf, reason, rule });
    };
    const punctAfter = (e: number) => /^[ \t]*[,!:;.?]|^[ \t]*(?:\r?\n|$)/.test(t.slice(e, e + 8));

    // greetings: "Hi Tom,"  "Dear John Smith"
    for (const m of matchAll(RE_GREET, t)) {
      const g = groupSpan(m, 1)!;
      const r = trimPhrase(t, g[0], m[1], { single: 'first', punct: punctAfter(g[1]) });
      if (r) add(r.s, r.e, 0.86, `name after the greeting '${m[0].slice(0, m[0].length - m[1].length).trim()}'`, 'greeting');
    }
    // honorific + name
    for (const m of matchAll(RE_HON, t)) {
      const g = groupSpan(m, 1)!;
      const r = trimPhrase(t, g[0], m[1], { single: 'any', punct: true, listTail: true });
      if (r) add(r.s, r.e, 0.88, `name after the title '${m[0].slice(0, m[0].length - m[1].length).trim()}'`, 'honorific');
    }
    // signatures
    for (const m of matchAll(RE_SIGN, t)) {
      const g = groupSpan(m, 1)!;
      const r = trimPhrase(t, g[0], m[1], { single: 'first', punct: true, needList: true });
      if (r) add(r.s, r.e, 0.85, 'name on the line after a sign-off', 'signature');
    }
    for (const m of matchAll(RE_SIGN_INLINE, t)) {
      const g = groupSpan(m, 1)!;
      const r = trimPhrase(t, g[0], m[1], { single: 'first', punct: true });
      if (r) add(r.s, r.e, 0.8, 'first name right after a sign-off', 'signature');
    }
    // "my name is …", "I am …"
    for (const m of matchAll(RE_INTRO_STRONG, t)) {
      const g = groupSpan(m, 1)!;
      const r = trimPhrase(t, g[0], m[1], { single: 'any', punct: true });
      if (r) add(r.s, r.e, 0.85, 'self-introduction', 'intro');
    }
    for (const m of matchAll(RE_INTRO_WEAK, t)) {
      const g = groupSpan(m, 1)!;
      const r = trimPhrase(t, g[0], m[1], { single: 'first', punct: true, needList: true });
      if (r) add(r.s, r.e, 0.72, 'self-introduction', 'intro');
    }
    // labelled fields
    for (const m of matchAll(RE_LABEL, t)) {
      const g = groupSpan(m, 2)!;
      const generic = !/^(?:contact|contact person|ansprechpartner(?:in)?|kontakt|employee|mitarbeiter(?:in)?|customer name)$/i.test(m[1]);
      const r = trimPhrase(t, g[0], m[2], { single: 'any', punct: true, needList: generic });
      if (r) add(r.s, r.e, 0.84, `value of the label '${m[1]}'`, 'label');
    }
    ctx.check();
    // mail headers and "Name <email>"
    for (const m of matchAll(RE_HEADER, t)) {
      const g = groupSpan(m, 1);
      if (!g) continue;
      const value = m[1];
      let found = false;
      for (const d of matchAll(new RegExp(RE_DISPLAY.source, 'gud'), value)) {
        const q = groupSpan(d, 1) ?? groupSpan(d, 2);
        if (!q) continue;
        const name = value.slice(q[0], q[1]).trim();
        if (/^\p{Lu}/u.test(name) && !FUNC_STOP.has(lc(name.split(/\s+/)[0]))) {
          add(g[0] + q[0], g[0] + q[1], 0.9, 'display name in a mail header', 'header');
          found = true;
        }
      }
      if (!found && !value.includes('<') && !value.includes('@')) {
        let off = 0;
        for (const part of value.split(/[;,]/)) {
          const name = part.trim();
          const pm = new RegExp(`^${PHRASE}$`, 'u').exec(name);
          if (pm) {
            const r = trimPhrase(t, g[0] + off + part.indexOf(name), name, { single: 'first', punct: true });
            if (r) add(r.s, r.e, 0.8, 'name in a mail header', 'header');
          }
          off += part.length + 1;
        }
      }
    }
    for (const m of matchAll(RE_DISPLAY, t)) {
      const q = groupSpan(m, 1) ?? groupSpan(m, 2);
      if (!q) continue;
      const name = t.slice(q[0], q[1]).trim();
      if (/^\p{Lu}/u.test(name) && name.includes(' ') && !FUNC_STOP.has(lc(name.split(/\s+/)[0]))) add(q[0], q[1], 0.85, "name in front of an <email address>", 'name-email');
    }
    // chat log speakers: "[09:14] anna: ..."
    for (const m of matchAll(RE_CHAT, t)) {
      const g = groupSpan(m, 1)!;
      const h = lc(m[1]);
      if (h.length >= 3 && inLists(h) && !FUNC_STOP.has(h) && !COMMON.has(h)) add(g[0], g[1], 0.76, 'speaker label of a chat log', 'chat');
    }
    // structured: "name": "Maria Lopez"
    for (const p of doc.pairs) {
      if (!NAME_KEYS.test(p.key.trim())) continue;
      const v = t.slice(p.valStart, p.valEnd);
      const single = /^(?:first|last|sur|vorname|nachname|prenom|prénom)/i.test(p.key);
      if (!new RegExp(`^${PHRASE}$`, 'u').test(v)) continue;
      const r = trimPhrase(t, p.valStart, v, { single: single ? 'any' : 'first', punct: true, needList: true });
      if (r) add(r.s, r.e, 0.8, `value of the key '${p.key}'`, 'pair');
    }
    ctx.check();

    // names derived from detected email addresses: john.smith@ → John Smith
    const derived = derivedFromEmails(t);
    if (derived.length) {
      const forms: string[] = [];
      for (const d of derived) {
        forms.push(`${ci(d.first)}[ \\t]+${ci(d.last)}`, `${ci(d.last)},?[ \\t]+${ci(d.first)}`);
      }
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.join('|')})(?![\\p{L}\\p{N}])`, 'gud');
      for (const m of matchAll(re, t)) add(m.index, m.index + m[0].length, 0.86, 'name derived from an email address in this text', 'email-derived');
    }

    // propagate cue-verified names to their other occurrences
    const known = new Map<string, number>();
    for (const c of cands) {
      if (c.rule === 'chat') continue;
      const name = t.slice(c.s, c.e);
      known.set(name, Math.max(known.get(name) ?? 0, c.conf));
      const toks = name.split(/[ \t]+/).filter((x) => isCap(x) && !/\.$/.test(x));
      if (toks.length > 1) {
        const f = toks[0];
        const l = toks[toks.length - 1];
        if (f.length >= 3 && isFirst(f) && !COMMON.has(lc(f))) known.set(f, Math.max(known.get(f) ?? 0, 0.74));
        if (l.length >= 4 && lists().LAST.has(lc(l)) && !COMMON.has(lc(l))) known.set(l, Math.max(known.get(l) ?? 0, 0.72));
      } else if (name.length >= 3 && isFirst(name) && !COMMON.has(lc(name))) known.set(name, Math.max(known.get(name) ?? 0, 0.78));
    }
    if (known.size) {
      const names = [...known.keys()].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length).slice(0, 400);
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`, 'gud');
      const SURN = new RegExp(`^[ \\t]+(${WORD})(?![\\p{L}\\p{N}])`, 'u');
      for (const m of matchAll(re, t)) {
        let end = m.index + m[0].length;
        // a known first name followed by one more capitalized word: that word is most likely its surname
        if (!m[0].includes(' ') && isFirst(m[0])) {
          const nx = SURN.exec(t.slice(end, end + 40));
          const w = nx?.[1];
          if (w && w.length >= 3 && !FUNC_STOP.has(lc(w)) && !COMMON.has(lc(w)) && !/^[ \t]*\p{Lu}/u.test(t.slice(end + nx![0].length, end + nx![0].length + 3))) end += nx![0].length;
        }
        add(m.index, end, Math.min(known.get(m[0]) ?? 0.74, 0.82), 'same name as one found with a cue elsewhere in this text', 'propagated');
      }
    }

    // aggressive: list-verified "First Last" pairs without any cue
    if (rank >= SENS_RANK.aggressive) {
      for (const m of matchAll(RE_PAIR, t)) {
        const a = m[1];
        const b = m[2];
        if (a.length < 3 || b.length < 3) continue;
        if (FUNC_STOP.has(lc(a)) || FUNC_STOP.has(lc(b))) continue;
        if (!isFirst(a) || !inLists(b)) continue;
        if (COMMON.has(lc(a)) && COMMON.has(lc(b))) continue;
        add(m.index, m.index + m[0].length, 0.55, 'first name followed by a known surname', 'list-pair');
      }
    }

    const hits: Hit[] = cands.map((c) => mkHit(ID, 'PERSON', c.s, c.e, c.conf, c.reason, c.rule === 'list-pair' ? 1 : 2, c.rule));
    return hits;
  },
};

