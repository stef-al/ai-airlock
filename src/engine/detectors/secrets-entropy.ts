import { isPlaceholderValue, isReference } from '../cues';
import { SENS_RANK, type Detector, type Doc, type Hit, type Settings } from '../types';
import { charClasses, lineBounds, shannon } from '../util';
import { analyzerFor, mkHit } from './helpers';

const ID = 'secrets.entropy';

const CAND = /(?<![A-Za-z0-9+/_=.~-])[A-Za-z0-9+/_=.~-]{16,200}(?![A-Za-z0-9+/_=.~-])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;
const HASH_CUE = /(?:hash|sha\d*|md5|checksum|digest|etag|integrity|commit|revision|rev|fingerprint|thumbprint|crc|signature)\b/i;
const VERSION = /^v?\d+(?:\.\d+){1,4}(?:[-+][\w.]+)?$/i;
const CSS_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const IDENT_LIKE = /^(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:[_-][a-z0-9]+)+|[A-Z0-9]+(?:_[A-Z0-9]+)+)$/;
const FILEISH = /\.[A-Za-z0-9]{1,5}$/;
const WORD_RE = /[A-Za-z\u00C0-\u024F][\w\u00C0-\u024F-]{1,40}/g;
/** "Key", "signingKey", "aes_key": a value named like a key (but not a public key or a key id). */
const KEY_NAME = /(?:^|[_.-])key$|[a-z0-9]Key$|^key$/i;
const NOT_KEY_NAME = /pub(?:lic)?[_.-]?key$|publicKey$|key[_.-]?id$|^(?:primary|foreign|sort|partition|hash|range|cache|object|map|dict|row|column|i18n|translation|react)[_.-]?key$/i;
/** base64 lengths of md5 / sha1 / sha256 / sha384 / sha512 digests */
const B64_DIGEST_LEN = new Set([22, 24, 27, 28, 43, 44, 64, 86, 88]);

const SHAPES: { re: RegExp; label: string }[] = [
  { re: /(?<![A-Za-z0-9])[A-Z][a-z]{3,10}[-_.]?(?:19|20)\d{2}[!@#$%^&*?+.]{1,3}(?![A-Za-z0-9])/g, label: 'word + year + symbol' },
  { re: /(?<![A-Za-z0-9])[A-Za-z]{4,12}[0-9]{1,4}[!@#$%^&*?]{1,3}(?![A-Za-z0-9])/g, label: 'word + digits + symbol' },
  { re: /(?<![A-Za-z0-9])[A-Za-z]*[Pp]@(?:ss|55)[Ww]0?rd[A-Za-z0-9!@#$%^&*?]{0,6}(?![A-Za-z0-9])/g, label: 'leet-speak password' },
  { re: /(?<![A-Za-z0-9])[A-Z][a-z]{3,10}[!@#$%^&*?][A-Za-z]{0,4}[0-9]{2,4}(?![A-Za-z0-9])/g, label: 'word + symbol + digits' },
];

interface Ex {
  uuid: boolean;
  gitSha: boolean;
  hashes: boolean;
  dataUri: boolean;
  cssColor: boolean;
  version: boolean;
}

function dataUriRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9=.-]+)*;base64,[A-Za-z0-9+/=_-]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

function threshold(cls: string): number {
  return cls === 'hex' ? 3.0 : cls === 'b64' ? 4.1 : 3.8;
}

export function charset(s: string): 'hex' | 'b64' | 'alnum' | 'other' {
  if (HEX.test(s)) return 'hex';
  if (/^[A-Za-z0-9]+$/.test(s)) return 'alnum';
  if (/^[A-Za-z0-9+/_=-]+$/.test(s)) return 'b64';
  return 'other';
}

function isExcluded(tok: string, ex: Ex, lineText: string, hashCue: boolean): string | null {
  if (ex.uuid && UUID.test(tok)) return 'uuid';
  if (ex.gitSha && /^[0-9a-f]{7,64}$/i.test(tok) && (/^[0-9a-f]{40}$/i.test(tok) || /^[0-9a-f]{64}$/i.test(tok) || /\b(?:commit|sha|git|merge|rev|hash)\b/i.test(lineText))) return 'git sha';
  if (ex.hashes && HEX.test(tok) && [32, 40, 56, 64, 96, 128].includes(tok.length) && hashCue) return 'hash';
  if (ex.hashes && /^(?:sha(?:1|256|384|512)|md5)[-:]/i.test(tok)) return 'hash';
  if (ex.cssColor && CSS_COLOR.test(tok)) return 'css color';
  if (ex.version && VERSION.test(tok)) return 'version';
  if (IDENT_LIKE.test(tok) && !/\d{3,}/.test(tok)) return 'identifier';
  return null;
}

export const secretsEntropy: Detector = {
  id: ID,
  label: 'Unknown-format secrets (entropy, password shapes)',
  category: 'secret',
  types: ['SECRET', 'PASSWORD'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  defaultSensitivity: 'balanced',
  detect(doc: Doc, cfg, ctx) {
    const rank = SENS_RANK[cfg.sensitivity];
    const text = doc.text;
    const ex = ctx.settings.exclusions;
    const out: Hit[] = [];
    const an = analyzerFor(ctx.settings);
    const uris = ex.dataUri ? dataUriRanges(text) : [];
    let ui = 0;
    const inUri = (p: number) => {
      while (ui < uris.length && uris[ui][1] <= p) ui++;
      return ui < uris.length && uris[ui][0] <= p;
    };
    /** a secret-like word shortly before the candidate (uses the multilingual cue list) */
    const cueBefore = (before: string) => {
      for (const w of before.match(WORD_RE) ?? []) {
        const ki = an.analyze(w);
        if (ki && !ki.negated) return true;
      }
      return false;
    };

    // --- high-entropy tokens ------------------------------------------------------------------
    CAND.lastIndex = 0;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = CAND.exec(text))) {
      if (++count > 200000) break;
      const tok = m[0];
      const s = m.index;
      if (inUri(s)) continue;
      if (tok.includes('..') || /^[.~-]/.test(tok) || tok.includes('//')) continue;
      if (/^\d+$/.test(tok) || FILEISH.test(tok) && /\./.test(tok)) continue;
      if (isPlaceholderValue(tok) || isReference(tok)) continue;
      const [ls, le] = lineBounds(text, s);
      const line = text.slice(ls, le);
      const before = text.slice(Math.max(ls, s - 60), s);
      const hashCue = HASH_CUE.test(before) || HASH_CUE.test(line.slice(0, 120));
      const why = isExcluded(tok, ex, line, hashCue);
      if (why) continue;
      const cs = charset(tok);
      if (cs === 'other') continue;
      // base64-encoded digests next to a hash cue (pin-sha256="…", integrity, checksums)
      if (ex.hashes && hashCue && cs === 'b64' && (B64_DIGEST_LEN.has(tok.length) || B64_DIGEST_LEN.has(tok.replace(/=+$/, '').length))) continue;
      const cueNear = cueBefore(before);
      const classes = charClasses(tok);
      const ent = shannon(tok);
      const keyed = (() => {
        const km = /([\w.-]{1,40})["']?\s*[:=]\s*["']?$/.exec(before);
        if (!km) return false;
        if (KEY_NAME.test(km[1]) && !NOT_KEY_NAME.test(km[1])) return true;
        const ki = an.analyze(km[1]);
        return !!ki && !ki.negated;
      })();
      let conf = 0;
      let reason = '';
      const th = threshold(cs);
      if (cs === 'hex') {
        if (tok.length < 20) continue;
        if (!(cueNear || keyed) && rank < 2) continue;
        if (ent >= th) {
          conf = keyed || cueNear ? 0.8 : 0.5;
          reason = `${tok.length}-character hex string${keyed || cueNear ? ' next to a secret-like name' : ''}`;
        }
      } else if (ent >= th && tok.length >= 20 && classes >= 2) {
        if (!/\d/.test(tok) && !/[+/_=]/.test(tok)) continue;
        conf = keyed || cueNear ? 0.82 : 0.55;
        reason = `high-entropy string (${ent.toFixed(1)} bits/char, ${tok.length} chars)${keyed || cueNear ? ' next to a secret-like name' : ''}`;
      } else if (keyed && tok.length >= 16 && ent >= 3.2 && classes >= 2) {
        conf = 0.7;
        reason = `random-looking value (${ent.toFixed(1)} bits/char) next to a secret-like name`;
      }
      if (!conf) continue;
      // balanced: only with a cue; aggressive: also free-standing
      if (rank < 2 && !(keyed || cueNear)) continue;
      out.push(mkHit(ID, 'SECRET', s, s + tok.length, conf, reason, 1, 'entropy'));
    }
    ctx.check();

    // --- common password shapes -----------------------------------------------------------------
    for (const sh of SHAPES) {
      sh.re.lastIndex = 0;
      while ((m = sh.re.exec(text))) {
        const tok = m[0];
        const s = m.index;
        const [ls] = lineBounds(text, s);
        const before = text.slice(Math.max(ls, s - 80), s);
        const cue = cueBefore(before) || /(?:\bpass|\bpw|\bpwd|\blogin|passwort|secret|credentials?)\W{0,20}$/i.test(before);
        const classes = charClasses(tok);
        if (classes < 3) continue;
        if (!cue && (rank < 2 || !/[!@#$%^&*?+]/.test(tok))) continue;
        if (VERSION.test(tok) || isPlaceholderValue(tok)) continue;
        out.push(mkHit(ID, 'PASSWORD', s, s + tok.length, cue ? 0.8 : 0.55, `common password shape (${sh.label})${cue ? ' near a password cue' : ''}`, 1, 'shape'));
      }
    }
    return out;
  },
};
export type { Settings };
