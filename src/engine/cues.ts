import { charClasses, nameTokens, shannon } from './util';

export type Strength = 'strong' | 'medium' | 'weak';

/** Default cue words: keyword -> [type, strength]. English plus de/fr/es/it/pl/cs. */
const KW: [string, string, Strength][] = [
  // passwords
  ['password', 'PASSWORD', 'strong'], ['passwords', 'PASSWORD', 'strong'], ['passwd', 'PASSWORD', 'strong'],
  ['pwd', 'PASSWORD', 'strong'], ['pword', 'PASSWORD', 'strong'], ['pswd', 'PASSWORD', 'strong'],
  ['passphrase', 'PASSWORD', 'strong'], ['passcode', 'PASSWORD', 'strong'], ['pass', 'PASSWORD', 'medium'],
  ['pw', 'PASSWORD', 'medium'], ['passw', 'PASSWORD', 'medium'], ['pass word', 'PASSWORD', 'strong'],
  ['passwort', 'PASSWORD', 'strong'], ['kennwort', 'PASSWORD', 'strong'], ['kennworte', 'PASSWORD', 'strong'],
  ['mot de passe', 'PASSWORD', 'strong'], ['motdepasse', 'PASSWORD', 'strong'], ['mdp', 'PASSWORD', 'medium'],
  ['contraseña', 'PASSWORD', 'strong'], ['contrasena', 'PASSWORD', 'strong'], ['clave', 'PASSWORD', 'weak'],
  ['parola', 'PASSWORD', 'weak'], ['hasło', 'PASSWORD', 'strong'], ['haslo', 'PASSWORD', 'strong'],
  ['heslo', 'PASSWORD', 'strong'], ['hesla', 'PASSWORD', 'strong'],
  ['requirepass', 'PASSWORD', 'strong'], ['masterauth', 'PASSWORD', 'strong'],
  ['pin', 'PIN', 'medium'], ['pincode', 'PIN', 'medium'],
  // secrets
  ['secret', 'SECRET', 'strong'], ['secrets', 'SECRET', 'strong'], ['geheimnis', 'SECRET', 'strong'],
  ['geheim', 'SECRET', 'medium'], ['secreto', 'SECRET', 'strong'], ['segreto', 'SECRET', 'strong'],
  ['sekret', 'SECRET', 'strong'], ['tajne', 'SECRET', 'medium'], ['tajemství', 'SECRET', 'strong'],
  ['private key', 'SECRET', 'strong'], ['privatekey', 'SECRET', 'strong'], ['secret key', 'SECRET', 'strong'],
  ['secretkey', 'SECRET', 'strong'], ['access key', 'SECRET', 'strong'], ['accesskey', 'SECRET', 'strong'],
  ['signing key', 'SECRET', 'strong'], ['encryption key', 'SECRET', 'strong'], ['master key', 'SECRET', 'strong'],
  ['license key', 'SECRET', 'medium'], ['auth key', 'SECRET', 'strong'], ['session key', 'SECRET', 'strong'],
  ['shared key', 'SECRET', 'strong'], ['account key', 'SECRET', 'strong'], ['storage key', 'SECRET', 'strong'],
  ['app key', 'SECRET', 'medium'], ['decryption key', 'SECRET', 'strong'], ['crypto key', 'SECRET', 'strong'],
  ['ssh key', 'SECRET', 'medium'], ['hmac key', 'SECRET', 'strong'], ['service key', 'SECRET', 'medium'],
  ['schlüssel', 'SECRET', 'weak'], ['clé', 'SECRET', 'weak'], ['chiave', 'SECRET', 'weak'], ['klucz', 'SECRET', 'weak'],
  ['klíč', 'SECRET', 'weak'],
  // api keys / tokens
  ['api key', 'API_KEY', 'strong'], ['apikey', 'API_KEY', 'strong'], ['api secret', 'SECRET', 'strong'],
  ['token', 'TOKEN', 'strong'], ['tokens', 'TOKEN', 'strong'], ['bearer', 'TOKEN', 'medium'], ['jeton', 'TOKEN', 'strong'],
  ['api token', 'TOKEN', 'strong'], ['sessionid', 'TOKEN', 'medium'], ['session id', 'TOKEN', 'medium'],
  // generic auth
  ['auth', 'SECRET', 'weak'], ['authorization', 'SECRET', 'weak'], ['credential', 'SECRET', 'medium'],
  ['credentials', 'SECRET', 'medium'], ['creds', 'SECRET', 'medium'], ['cred', 'SECRET', 'weak'],
  ['zugangsdaten', 'SECRET', 'medium'], ['identifiants', 'SECRET', 'medium'], ['sas', 'SECRET', 'weak'],
];

export const DEFAULT_KEYWORDS: string[] = KW.map((k) => k[0]);
const META = new Map<string, { type: string; strength: Strength }>(KW.map(([k, t, s]) => [k, { type: t, strength: s }]));

export const DEFAULT_QUALIFIERS: string[] = (
  'hash hashed hashing salt min max length len size policy policies rule rules required requirement requirements regex pattern ' +
  'file filename path paths dir directory url uri endpoint host hostname field fields label labels placeholder hint prompt text message msg ' +
  'error errors err type types kind name names id ids expiry expires expiration expire expired ttl timeout lifetime count counts ' +
  'attempts retries enabled disabled enable strength validator validators validation validate manager provider service ' +
  'repository repo controller helper util utils encoder encoding decoder factory handler filter config configuration class ' +
  'interface algorithm alg version mode format style source option options flag flags is has should can check verify ' +
  'stdin prompt dialog form input label title description desc tooltip visible show hide toggle icon button page view ' +
  'mismatch invalid incorrect wrong complexity history age days limit limits level levels required optional ' +
  'placeholder example sample mask masked schema model dto entity bean test tests mock store storage'
).split(/\s+/);

/** Class-like nouns that only cancel a cue when they come after it: PasswordService yes, ServicePassword no. */
const AFTER_ONLY = new Set(
  'service manager provider repository repo controller helper util utils encoder decoder factory handler filter validator validators config configuration class interface schema model dto entity bean test tests mock source store storage option options flag flags type types kind name names id ids label title description desc text message msg error errors err hint placeholder prompt dialog form input button page view icon tooltip visible show hide toggle format style mode version algorithm alg'.split(' '),
);

const VERBS = new Set('get is has check validate verify hash compare generate encode decode encrypt decrypt parse load read fetch find show hide toggle can should render format mask unmask display print log prompt ask'.split(' '));

// words that must never count as the cue even though they contain it
const NOT_CUE = new Set(['secretary', 'secretariat', 'secretive', 'secretion', 'secretly', 'tokenizer', 'tokenize', 'tokenization', 'tokenizers', 'compass', 'bypass', 'passage', 'passenger', 'passive', 'passion', 'passport', 'passing', 'password' + 'less']);

export interface KeyInfo {
  type: string;
  strength: Strength;
  keyword: string;
  negated: boolean;
  /** the qualifier that cancelled the cue, if negated */
  qualifier?: string;
}

const AFFIX_ANY = new Set(['password', 'passwd', 'passwort', 'kennwort', 'contrasena', 'apikey', 'secretkey', 'privatekey', 'accesskey', 'motdepasse', 'passphrase']);

export class KeyAnalyzer {
  private single = new Map<string, { type: string; strength: Strength }>();
  private phrases: { toks: string[]; type: string; strength: Strength; kw: string }[] = [];
  private longKws: { kw: string; type: string; strength: Strength }[] = [];
  private quals: Set<string>;
  /** Global, case-insensitive regex that finds raw occurrences of any cue (for text scanning). */
  readonly regex: RegExp;
  private cache = new Map<string, KeyInfo | null>();

  constructor(keywords: string[], qualifiers: string[]) {
    this.quals = new Set(qualifiers.map((q) => q.toLowerCase()));
    const seen = new Set<string>();
    const alts: string[] = [];
    for (const raw of keywords) {
      const kw = raw.trim().toLowerCase();
      if (!kw || seen.has(kw)) continue;
      seen.add(kw);
      const meta = META.get(kw) ?? { type: 'SECRET', strength: 'strong' as Strength };
      const toks = nameTokens(kw);
      if (toks.length > 1) {
        this.phrases.push({ toks, type: meta.type, strength: meta.strength, kw });
        // joined form also matches inside run-together names
        const joined = toks.join('');
        if (!META.has(joined) && !seen.has(joined)) {
          this.single.set(joined, meta);
          if (joined.length >= 6) this.longKws.push({ kw: joined, ...meta });
          alts.push(joined);
        }
        // the cue regex must find the phrase's last word anywhere it may form the key name
        alts.push(...toks.filter((t) => t.length >= 3));
      } else {
        this.single.set(kw, meta);
        if (kw.length >= 6 || AFFIX_ANY.has(kw)) this.longKws.push({ kw, ...meta });
        alts.push(kw);
      }
    }
    const uniq = [...new Set(alts)].sort((a, b) => b.length - a.length);
    const esc = uniq.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.regex = new RegExp(esc.length ? esc.join('|') : '(?!)', 'giu');
  }

  analyze(key: string): KeyInfo | null {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const r = this.compute(key);
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(key, r);
    return r;
  }

  private compute(key: string): KeyInfo | null {
    const toks = nameTokens(key.replace(/^[-$@_.]+/, ''));
    if (!toks.length) return null;
    let best: { type: string; strength: Strength; kw: string; idx: number } | null = null;
    const rank = (s: Strength) => (s === 'strong' ? 3 : s === 'medium' ? 2 : 1);
    const consider = (type: string, strength: Strength, kw: string, idx: number) => {
      if (!best || rank(strength) > rank(best.strength)) best = { type, strength, kw, idx };
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (NOT_CUE.has(t)) continue;
      const m = this.single.get(t);
      if (m) consider(m.type, m.strength, t, i);
      else
        for (const lk of this.longKws) {
          const at = t.indexOf(lk.kw);
          if (at < 0 || t === lk.kw) continue;
          const isAny = AFFIX_ANY.has(lk.kw);
          const suffix = at + lk.kw.length === t.length;
          if (!(isAny || suffix)) continue;
          const rem = at === 0 ? t.slice(lk.kw.length) : t.slice(0, at);
          if (rem.length > 14) continue;
          if (this.quals.has(rem)) {
            return { type: lk.type, strength: lk.strength, keyword: lk.kw, negated: true, qualifier: rem };
          }
          consider(lk.type, lk.strength, lk.kw, i);
        }
    }
    for (const p of this.phrases) {
      outer: for (let i = 0; i + p.toks.length <= toks.length; i++) {
        for (let j = 0; j < p.toks.length; j++) if (toks[i + j] !== p.toks[j]) continue outer;
        consider(p.type, p.strength, p.kw, i);
      }
    }
    if (!best) return null;
    const b = best as { type: string; strength: Strength; kw: string; idx: number };
    // verbs in front make it a function / predicate name: getPassword, isPasswordValid, hashPassword
    if (b.idx > 0 && VERBS.has(toks[0])) return { type: b.type, strength: b.strength, keyword: b.kw, negated: true, qualifier: toks[0] };
    for (let i = 0; i < toks.length; i++) {
      if (this.quals.has(toks[i]) && toks[i] !== b.kw) {
        if (i < b.idx && AFTER_ONLY.has(toks[i])) continue;
        // "pass_through"/"password_hash"/"MIN_LENGTH"
        return { type: b.type, strength: b.strength, keyword: b.kw, negated: true, qualifier: toks[i] };
      }
    }
    return { type: b.type, strength: b.strength, keyword: b.kw, negated: false };
  }
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

const REF_RES: RegExp[] = [
  /^%[-+# 0-9.]*[A-Za-z]$/,
  /^\{\d*\}$/,
  /^[?]$|^\$\d+$/,
  /\$\{[^}]*\}/,
  /^\$\(.*\)$/,
  /^\$[A-Za-z_][\w]*$/,
  /^%[^%\s]+%$/,
  /\{\{[^}]*\}\}/,
  /<%[^%]*%>/,
  /^#\{[^}]*\}$/,
  /^@\{[^}]*\}$/,
  /\bprocess\.env\b|\bos\.environ\b|\bos\.getenv\b|\bSystem\.getenv\b|\bgetenv\(|\bENV\[|\bEnvironment\.GetEnvironmentVariable\b|\bConfiguration\[|\bSettings\.|\bconfig\.get\(|\bimport\.meta\.env\b|\bDeno\.env\b|\bViper\b/i,
  /^(?:arn:aws[\w-]*:(?:secretsmanager|ssm|kms)|vault:|ssm:|ssm\/|secret\/|secrets\/|kv\/|projects\/[^/]+\/secrets\/|op:\/\/|keyvault:|azure-keyvault:|aws-ssm:|gcp-secret:|ref\+|file:\/\/|\/run\/secrets\/|\/var\/run\/secrets\/|secretsmanager:|\$\{?vault)/i,
  /^!(?:Ref|Sub|GetAtt|ImportValue|Join)\b/,
  /^\*[A-Za-z_]\w*$/,
  /^&[A-Za-z_]\w*/,
  /^ENC\[|^ENC\(/,
  /^\{\s*[A-Za-z_][\w.]*\s*\}$/,
];

const PLACEHOLDER_RES: RegExp[] = [
  /^<[^<>]{0,60}>$/,
  /^\[[^\[\]]{0,60}\]$/,
  /^\{[^{}]{0,60}\}$/,
  /^[xX*•●·.\-_#?~]{1,}$/,
  /^(?:your|my|the|enter|insert|put|replace|some|a)[\s_-]*(?:\w+[\s_-]+){0,2}(?:password|passwd|pass|pwd|secret|token|key|api[\s_-]?key|credentials?|value)(?:[\s_-]*here)?$/i,
  /^(?:change[\s_-]?me[\s_-]?(?:please|now)?|replace[\s_-]?me|redacted|removed|hidden|masked|censored|placeholder|todo|tbd|fixme|dummy|example|sample|none|null|nil|n\/a|na|unset|undefined|empty|default|required|optional)$/i,
  /^(?:true|false|yes|no|on|off|y|n|0|1)$/i,
  /^(?:string|str|text|int|integer|bool|boolean|number|float|double|object|array|any|password|secret|token|hidden)$/i,
  /^\[?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_\d+\]?$/, // already a placeholder of ours
  /^[\w.+-]*user\d+@example\.(?:com|org|net)$/i,
  /^\.\.\.$/,
];

export function isReference(v: string): boolean {
  return REF_RES.some((r) => r.test(v));
}

export function isPlaceholderValue(v: string): boolean {
  return PLACEHOLDER_RES.some((r) => r.test(v));
}

const FILE_PATH = /^(?:[A-Za-z]:\\|~?\/|\.{1,2}\/)[\w.\/\\ -]*\.(?:pem|key|crt|cer|p12|pfx|jks|txt|json|ya?ml|env|conf|ini|pub|gpg|asc|keystore)$/i;
const PLAIN_URL = /^[a-z][a-z0-9+.-]*:\/\/[^@\s]*$/i;
const VERSION_RE = /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?$/i;
const STOP_PROSE = new Set(
  'correct incorrect required wrong invalid valid too short long weak strong empty missing expired reset changed set not null verified matched match mismatch accepted rejected denied granted ok failed success successful update updated forgotten sent hidden visible different same'.split(' '),
);

export interface ValueOpts {
  strength: Strength;
  type: string;
  quoted: boolean;
  /** key allows multi-word values (passphrase) */
  passphrase?: boolean;
  /** the key name, to detect values that merely repeat it */
  key?: string;
  /** true when found by free-text scanning (prose/log) */
  loose?: boolean;
}

export interface Verdict {
  ok: boolean;
  conf: number;
  why: string;
}

export function valueVerdict(raw: string, o: ValueOpts): Verdict {
  const v = raw.trim();
  if (!v) return { ok: false, conf: 0, why: 'empty' };
  if (isReference(v)) return { ok: false, conf: 0, why: 'reference' };
  if (isPlaceholderValue(v)) return { ok: false, conf: 0, why: 'placeholder' };
  if (o.type === 'PIN') {
    if (!/^\d{3,8}$/.test(v)) return { ok: false, conf: 0, why: 'not a PIN' };
    return { ok: true, conf: o.strength === 'strong' ? 0.85 : 0.75, why: '' };
  }
  const words = v.split(/\s+/).length;
  if (words > (o.passphrase ? 12 : 3) || (words === 3 && !o.passphrase)) return { ok: false, conf: 0, why: 'sentence' };
  if (words === 2 && !o.passphrase && !o.quoted) return { ok: false, conf: 0, why: 'sentence' };
  if (PLAIN_URL.test(v) && o.type !== 'PASSWORD') return { ok: false, conf: 0, why: 'url' };
  if (FILE_PATH.test(v)) return { ok: false, conf: 0, why: 'path' };
  if (VERSION_RE.test(v) && o.strength !== 'strong') return { ok: false, conf: 0, why: 'version' };
  const len = v.length;
  const numeric = /^\d+$/.test(v);
  if (numeric) {
    if (o.type === 'TOKEN' && len < 6) return { ok: false, conf: 0, why: 'short number' };
    if (len < 4) return { ok: false, conf: 0, why: 'short number' };
    if (o.strength !== 'strong' && len < 6) return { ok: false, conf: 0, why: 'number' };
  }
  const minLen = o.strength === 'strong' ? 3 : o.strength === 'medium' ? 4 : 8;
  if (len < minLen) return { ok: false, conf: 0, why: 'too short' };
  const cls = charClasses(v);
  if (o.strength === 'weak') {
    const ent = shannon(v);
    if (!(cls >= 2 && len >= 8) && !(ent >= 3.5 && len >= 12)) return { ok: false, conf: 0, why: 'not secret-shaped' };
  }
  let conf = o.strength === 'strong' ? 0.9 : o.strength === 'medium' ? 0.78 : 0.62;
  if (len < 6) conf -= 0.1;
  if (/^[a-z]+$/.test(v) && len <= 8) conf -= 0.1;
  if (cls >= 3 && len >= 8) conf += 0.05;
  if (cls >= 2 && len >= 12) conf += 0.03;
  if (o.quoted) conf += 0.02;
  if (/\s/.test(v)) conf -= 0.1;
  if (o.loose) conf -= 0.05;
  // value that merely contains a cue word looks like a reference, not a literal
  if (/^[a-z][a-z0-9_.-]*$/i.test(v) && /pass|secret|token|key/i.test(v) && !/\d/.test(v)) conf -= 0.25;
  if (o.loose && STOP_PROSE.has(v.toLowerCase())) return { ok: false, conf: 0, why: 'prose word' };
  if (conf < 0.45) return { ok: false, conf, why: 'low confidence' };
  return { ok: true, conf: Math.min(0.99, Math.max(0.45, conf)), why: '' };
}

/** Does a prose-style value (after "password is") look like a password rather than a word? */
export function proseValueLooksSecret(v: string, quoted: boolean, aggressive: boolean): boolean {
  if (quoted) return true;
  if (/\d/.test(v) || /[^A-Za-z0-9À-ɏ]/.test(v)) return true;
  if (/[a-z]/.test(v) && /[A-Z]/.test(v.slice(1))) return true;
  return aggressive && v.length >= 5 && !STOP_PROSE.has(v.toLowerCase());
}
