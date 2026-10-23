import { isPlaceholderValue, isReference, proseValueLooksSecret, valueVerdict, type KeyAnalyzer } from '../cues';
import { SENS_RANK, type Detector, type Doc, type Hit, type Pair } from '../types';
import { isWordCh, nameTokens } from '../util';
import { analyzerFor, formatLabel, isStructured, mkHit } from './helpers';

const ID = 'secrets.context';

const SETTER = new Set('set with use add update change reset store save put create new init configure assign apply basic bearer'.split(' '));
const AUTHISH = new Set('login signin logon authenticate credentials credential connect connection getconnection createconnection auth basicauth'.split(' '));

const OPEN_Q = new Set(['"', "'", '`', '“', '„', '«', '‘']);
const CLOSE_Q: Record<string, string> = { '"': '"', "'": "'", '`': '`', '“': '”', '„': '“', '«': '»', '‘': '’' };

function isKeyCh(c: string): boolean {
  return isWordCh(c) || c === '.' || c === '-' || c === '$' || c === '@' || c >= 'À';
}

interface Val {
  s: number;
  e: number;
  quoted: boolean;
}

function readValue(t: string, v: number): Val | null {
  const n = t.length;
  const c = t[v];
  if (c === undefined) return null;
  if (c === '\\' && (t[v + 1] === '"' || t[v + 1] === "'")) {
    const q = t[v + 1];
    const s = v + 2;
    const e = t.indexOf('\\' + q, s);
    if (e < 0 || e - s > 512 || t.slice(s, e).includes('\n')) return null;
    return { s, e, quoted: true };
  }
  if (OPEN_Q.has(c)) {
    const q = CLOSE_Q[c];
    let j = v + 1;
    while (j < n && j - v < 520) {
      if (t[j] === '\\' && q === '"') {
        j += 2;
        continue;
      }
      if (t[j] === q || t[j] === '\n') break;
      j++;
    }
    if (t[j] !== q) return null;
    return { s: v + 1, e: j, quoted: true };
  }
  if (c === '[' || c === '{' || c === '(' || c === '<' || c === '\n' || c === '\r') return null;
  let j = v;
  while (j < n && j - v < 256) {
    const ch = t[j];
    if (/[\s;&"'`<>]/.test(ch)) break;
    if (ch === ',' && (j + 1 >= n || /\s/.test(t[j + 1]))) break;
    j++;
  }
  let e = j;
  // trim trailing sentence punctuation / unmatched closers
  while (e > v) {
    const ch = t[e - 1];
    if (ch === '.' || ch === ',' || ch === ':' || ch === ';') e--;
    else if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      if (t.slice(v, e - 1).includes(open)) break;
      e--;
    } else break;
  }
  if (e <= v) return null;
  return { s: v, e, quoted: false };
}

const PROSE_CONN =
  /\s+(?:(?:for|of|to|von|für|fuer|pour|de|para|per|di|pro|dla)\s+(?:the\s+|der\s+|die\s+|den\s+|dem\s+|le\s+|la\s+|les\s+|el\s+|il\s+|l')?[\p{L}\d._@-]+(?:\s+[\p{L}\d._@-]+){0,2}?\s+)?(?:is|was|will\s+be|should\s+be|lautet|ist|war|est|était|es|era|è|jest|je|byl|bylo|to)\s*:?\s+/iuy;

function methodLabel(doc: Doc, p: Pair): string {
  const l = formatLabel(doc);
  return doc.format === 'markdown' ? '' : ` in ${l}`;
}

function fromPair(doc: Doc, p: Pair, an: KeyAnalyzer, aggressive: boolean): Hit | null {
  const t = doc.text;
  const raw = t.slice(p.valStart, p.valEnd);
  if (p.hint === 'k8s-secret') {
    if (!raw.trim() || isReference(raw)) return null;
    return mkHit(ID, 'SECRET', p.valStart, p.valEnd, 0.95, `value under '${p.path?.split('.')[0]}' of a Kubernetes Secret`, 2, 'k8s-secret');
  }
  if (p.hint === 'docker-auth' && /^(auth|password|identitytoken|registrytoken)$/i.test(p.key)) {
    if (!raw.trim()) return null;
    return mkHit(ID, 'SECRET', p.valStart, p.valEnd, 0.93, `registry credential '${p.key}' in a Docker config`, 2, 'docker-auth');
  }
  if (p.kind === 'call') return fromCall(doc, p, an);
  const ki = an.analyze(p.key);
  if (!ki || ki.negated) return null;
  let vs = p.valStart;
  let value = raw;
  const auth = /^(Bearer|Basic|Token|Digest)\s+/i.exec(value);
  if (auth) {
    vs += auth[0].length;
    value = value.slice(auth[0].length);
  }
  const v = valueVerdict(value, {
    strength: ki.strength,
    type: ki.type,
    quoted: p.quote !== '' && p.quote !== 'block',
    passphrase: /passphrase|seed|mnemonic/.test(ki.keyword),
    key: p.key,
  });
  if (!v.ok) return null;
  if (!aggressive && ki.strength === 'weak' && v.conf < 0.6) return null;
  const how = p.kind === 'sql' ? `value for column '${p.key}' in SQL INSERT` : `literal assigned to key '${p.key}'${methodLabel(doc, p)}`;
  return mkHit(ID, ki.type, vs, p.valEnd, v.conf + 0.02, how, 2, 'pair');
}

function fromCall(doc: Doc, p: Pair, an: KeyAnalyzer): Hit | null {
  const t = doc.text;
  const raw = t.slice(p.valStart, p.valEnd);
  if (p.numeric) return null;
  const toks = nameTokens(p.key);
  const ki = an.analyze(p.key);
  const last = (p.argIndex ?? 0) === (p.argCount ?? 1) - 1;
  if (ki && !ki.negated) {
    const idx = toks.findIndex((x) => x === ki.keyword || x.includes(ki.keyword.replace(/\s/g, '')));
    const setterOk = idx <= 0 || toks.slice(0, idx).every((x) => SETTER.has(x));
    if (!setterOk || !last) return null;
    const v = valueVerdict(raw, { strength: ki.strength, type: ki.type, quoted: true });
    if (!v.ok) return null;
    return mkHit(ID, ki.type, p.valStart, p.valEnd, v.conf, `argument of ${p.key}(…) in ${formatLabel(doc)}`, 2, 'call-cue');
  }
  if (toks.some((x) => AUTHISH.has(x)) && (p.argCount ?? 0) >= 2 && last) {
    const v = valueVerdict(raw, { strength: 'medium', type: 'PASSWORD', quoted: true });
    if (!v.ok || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
    return mkHit(ID, 'PASSWORD', p.valStart, p.valEnd, Math.min(v.conf, 0.74), `last literal argument of ${p.key}(…) looks like a password`, 2, 'call-auth');
  }
  return null;
}

function scanText(doc: Doc, an: KeyAnalyzer, aggressive: boolean, skip: Set<number>): Hit[] {
  const t = doc.text;
  const n = t.length;
  const out: Hit[] = [];
  const re = an.regex;
  re.lastIndex = 0;
  const structured = isStructured(doc);
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(t))) {
    if (++guard > 400000) break;
    const kStart = m.index;
    const kEnd = kStart + m[0].length;
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    let ws = kStart;
    while (ws > 0 && kStart - ws < 64 && isKeyCh(t[ws - 1])) ws--;
    let we = kEnd;
    while (we < n && we - kEnd < 64 && isKeyCh(t[we])) we++;
    re.lastIndex = Math.max(we, kEnd);
    while (we > kEnd && (t[we - 1] === '.' || t[we - 1] === '-')) we--;
    // pick the dotted segment containing the cue; it must be the last one (password.length is not a secret)
    const dot = t.lastIndexOf('.', kStart - 1);
    let segStart = dot >= ws && dot < kStart ? dot + 1 : ws;
    const nextDot = t.indexOf('.', kEnd);
    if (nextDot >= 0 && nextDot < we) continue;
    let flag = false;
    let k0 = segStart;
    while (k0 < kStart && (t[k0] === '-' || t[k0] === '$' || t[k0] === '@')) {
      if (t[k0] === '-') flag = true;
      k0++;
    }
    if (flag && !(segStart === 0 || /[\s=\[(,]/.test(t[segStart - 1]))) flag = false;
    const word = t.slice(k0, we);
    const ki = an.analyze(word);
    if (!ki || ki.negated) continue;

    // closing quotes / escapes of a quoted key, then the delimiter
    let p = we;
    while (p < n && (t[p] === '"' || t[p] === "'" || t[p] === '`' || t[p] === ']' || t[p] === '\\')) p++;
    let q = p;
    while (q < n && (t[q] === ' ' || t[q] === '\t')) q++;
    const sym = /^(?::=|=>|===|==|=|:)/.exec(t.slice(q, q + 3));
    let vstart = -1;
    let loose = false;
    if (sym) {
      if (sym[0] === ':' && (t[q + 1] === ':' || t[q + 1] === '/')) continue;
      let a = q + sym[0].length;
      while (a < n && (t[a] === ' ' || t[a] === '\t')) a++;
      vstart = a;
    } else if (flag && q > p) {
      if (t[q] === '-') continue;
      vstart = q;
    } else if (/^[\p{L}]+$/u.test(word) && q > p - 0) {
      PROSE_CONN.lastIndex = we;
      const pc = PROSE_CONN.exec(t);
      if (pc) {
        vstart = we + pc[0].length;
        loose = true;
      }
    }
    if (vstart < 0) continue;
    const val = readValue(t, vstart);
    if (!val) continue;
    if (skip.has(val.s)) continue;
    const value = t.slice(val.s, val.e);
    // sentences: "Password: please enter ..." in free text
    if (!val.quoted && !structured) {
      const rest = t.slice(val.e, val.e + 24);
      if (/^[ \t]+[a-z]{2,}/.test(rest) && /^[A-Za-z]+$/.test(value) && !loose) continue;
    }
    let vs = val.s;
    let text = value;
    const auth = /^(Bearer|Basic|Token|Digest)\s+(?=\S)/i.exec(text);
    if (auth) {
      vs += auth[0].length;
      text = text.slice(auth[0].length);
    }
    if (loose && !proseValueLooksSecret(text, val.quoted, aggressive)) continue;
    const v = valueVerdict(text, {
      strength: ki.strength,
      type: ki.type,
      quoted: val.quoted,
      passphrase: /passphrase|seed|mnemonic/.test(ki.keyword),
      key: word,
      loose,
    });
    if (!v.ok) continue;
    if (!aggressive && ki.strength === 'weak' && v.conf < 0.6) continue;
    const how = loose ? `value stated after '${t.slice(kStart, kEnd)}' in text` : flag ? `value of command-line flag '${t.slice(segStart, we)}'` : `literal assigned to '${word}'`;
    out.push(mkHit(ID, ki.type, vs, vs + text.length, v.conf, how, 2, loose ? 'prose' : flag ? 'cli-flag' : 'text-kv'));
  }
  return out;
}

const USER_PASS =
  /\b(?:user(?:name)?|login|benutzer(?:name)?|utilisateur|usuario|utente|u[zž]ivatel)\s*[/|]\s*(?:pass(?:word)?|pw|pwd|passwort|kennwort|mot de passe|contrase[ñn]a|has[lł]o|heslo)\s*[:=\-]?\s*([^\s/|]{1,64})\s*[/|]\s*([^\s/|]{3,64})/giu;
const AUTH_TUPLE = /\b(?:auth|credentials|basic_?auth|http_?auth)\s*[=:]\s*[(\[]\s*(['"])([^'"\n]{0,64})\1\s*,\s*(['"])([^'"\n]{3,128})\3\s*[)\]]/gi;

function extra(doc: Doc, skip: Set<number>): Hit[] {
  const t = doc.text;
  const out: Hit[] = [];
  USER_PASS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = USER_PASS.exec(t))) {
    const v = m[2];
    const s = m.index + m[0].length - v.length;
    if (isPlaceholderValue(v) || isReference(v) || skip.has(s)) continue;
    out.push(mkHit(ID, 'PASSWORD', s, s + v.length, 0.8, "second value of a 'user / password' pair in text", 2, 'user-pass'));
  }
  AUTH_TUPLE.lastIndex = 0;
  while ((m = AUTH_TUPLE.exec(t))) {
    const v = m[4];
    const s = m.index + m[0].lastIndexOf(v);
    if (isPlaceholderValue(v) || isReference(v) || skip.has(s)) continue;
    out.push(mkHit(ID, 'PASSWORD', s, s + v.length, 0.8, 'password in an (user, password) auth tuple', 2, 'auth-tuple'));
  }
  return out;
}

export const secretsContext: Detector = {
  id: ID,
  label: 'Secrets by context (names, assignments, prose)',
  category: 'secret',
  types: ['PASSWORD', 'SECRET', 'TOKEN', 'API_KEY', 'PIN'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, cfg, ctx) {
    if (SENS_RANK[cfg.sensitivity] < SENS_RANK.balanced) return [];
    const an = analyzerFor(ctx.settings);
    const aggressive = cfg.sensitivity === 'aggressive';
    const hits: Hit[] = [];
    const skip = new Set<number>();
    for (const p of doc.pairs) {
      const h = fromPair(doc, p, an, aggressive);
      if (h) {
        hits.push(h);
        skip.add(h.start);
      }
      skip.add(p.valStart);
    }
    ctx.check();
    hits.push(...scanText(doc, an, aggressive, skip));
    ctx.check();
    hits.push(...extra(doc, skip));
    return hits;
  },
};
