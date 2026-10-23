// Test-time generators for secret-looking values. Nothing here is a real credential and no full
// token ever appears in source: values are assembled from seeds so secret scanners stay quiet.

function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HEX = '0123456789abcdef';
const B64 = ALNUM + '+/';
const B64U = ALNUM + '-_';

function pick(alpha: string, len: number, seed: number, mixed = true): string {
  const r = rng(seed);
  for (let attempt = 0; attempt < 50; attempt++) {
    let s = '';
    for (let i = 0; i < len; i++) s += alpha[Math.floor(r() * alpha.length)];
    if (!mixed || (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) || alpha === HEX || alpha === B32) return s;
  }
  return 'aB3'.repeat(Math.ceil(len / 3)).slice(0, len);
}

const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function luhnDigit(body: string): string {
  let sum = 0;
  let alt = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let d = +body[i];
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}

function ibanOf(cc: string, len: number, seed: number): string {
  const r = rng(seed);
  let bban = '';
  for (let i = 0; i < len - 4; i++) bban += String(Math.floor(r() * 10));
  let rem = 0;
  for (const ch of bban + cc + '00') {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : +ch;
    rem = v > 9 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  const raw = cc + String(98 - rem).padStart(2, '0') + bban;
  return raw.replace(/(.{4})/g, '$1 ').trim();
}

export function expandMacro(name: string, args: string[]): string {
  const seed = Number(args[args.length - 1]) || 1;
  switch (name) {
    case 'aws': return 'AK' + 'IA' + pick(B32, 16, seed);
    case 'awssecret': return pick(B64, 40, seed);
    case 'gh': return 'gh' + 'p_' + pick(ALNUM, 36, seed);
    case 'ghpat': return 'github' + '_pat_' + pick(ALNUM, 22, seed) + '_' + pick(ALNUM, 40, seed + 1);
    case 'gl': return 'gl' + 'pat-' + pick(B64U, 20, seed);
    case 'slack': return 'xo' + 'xb-' + pick('0123456789', 12, seed, false) + '-' + pick('0123456789', 13, seed + 1, false) + '-' + pick(ALNUM, 24, seed + 2);
    case 'stripe': return 'sk' + '_live_' + pick(ALNUM, 24, seed);
    case 'npm': return 'npm' + '_' + pick(ALNUM, 36, seed);
    case 'oai': return 'sk' + '-proj-' + pick(B64U, 48, seed);
    case 'ant': return 'sk' + '-ant-api03-' + pick(B64U, 60, seed);
    case 'gcp': return 'AI' + 'za' + pick(B64U, 35, seed);
    case 'hf': return 'hf' + '_' + pick(ALNUM, 34, seed);
    case 'sg': return 'S' + 'G.' + pick(B64U, 22, seed) + '.' + pick(B64U, 43, seed + 1);
    case 'jwt': {
      const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const p = b64url(JSON.stringify({ sub: 'u' + seed, name: 'Test User', iat: 1700000000 + seed }));
      return `${h}.${p}.${pick(B64U, 43, seed)}`;
    }
    case 'pem': {
      const lines: string[] = [];
      for (let i = 0; i < 6; i++) lines.push(pick(B64, 64, seed + i, false));
      lines.push(pick(B64, 40, seed + 9, false) + '==');
      return ['-----BEGIN ' + 'RSA PRIVATE KEY-----', ...lines, '-----END ' + 'RSA PRIVATE KEY-----'].join('\n');
    }
    case 'bcrypt': return '$' + '2b$12$' + pick('./' + ALNUM, 53, seed);
    case 'sha512crypt': return '$' + '6$' + pick(ALNUM, 8, seed) + '$' + pick('./' + ALNUM, 86, seed + 1);
    case 'rand': return pick(ALNUM, Number(args[0]) || 24, seed);
    case 'b64': return pick(B64, Number(args[0]) || 32, seed);
    case 'hex': return pick(HEX, Number(args[0]) || 32, seed, false);
    case 'uuid': {
      const h = pick(HEX, 32, seed, false);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    }
    case 'card': {
      const prefix = args[0] === 'mc' ? '5' + String(1 + (seed % 5)) : args[0] === 'amex' ? '37' : '4';
      const len = args[0] === 'amex' ? 15 : 16;
      let body = prefix;
      const r = rng(seed);
      while (body.length < len - 1) body += Math.floor(r() * 10);
      const full = body + luhnDigit(body);
      return args[0] === 'amex' ? `${full.slice(0, 4)} ${full.slice(4, 10)} ${full.slice(10)}` : full.replace(/(.{4})/g, '$1 ').trim();
    }
    case 'iban': return ibanOf(args[0] || 'DE', ({ DE: 22, GB: 22, FR: 27, NL: 18, ES: 24, IT: 27, PL: 28, CZ: 24 } as Record<string, number>)[args[0] || 'DE'] ?? 22, seed);
    default: throw new Error('unknown macro ' + name);
  }
}

export function expandMacros(text: string): string {
  return text.replace(/\{\{([a-z0-9]+)((?::[A-Za-z0-9]+)*)\}\}/g, (_m, name: string, rest: string) => expandMacro(name, rest ? rest.slice(1).split(':') : []));
}
