import { DEFAULT_HOST_SUFFIXES, opt } from '../settings';
import { SENS_RANK, type Detector, type Hit } from '../types';
import { escapeRegExp, matchAll } from '../util';
import { mkHit } from './helpers';

// ---------------------------------------------------------------------------------------------
// IPv4 / IPv6
// ---------------------------------------------------------------------------------------------

const OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\w.])(?<!\\d-)(?:${OCT}\\.){3}${OCT}(?![\\w]|\\.\\d)(?!-\\d)`, 'g');
/** Dotted quads after these words are versions or section numbers, not addresses ("section 24.5.1.1", "version 4.17.21.3"). */
const VERSION_WORD =
  /(?:\bv\d*|\bversions?|\bver\.?|\brelease|\bbuild|\brev(?:ision)?|\blibrary|\bpackage|\bsdk|\bsection|\bchapter|\bclause|\barticle|\bart\.|\bpara(?:graph)?|\bfigure|\bfig\.|§|\brfc|\bkernel|\bfirmware)["']?\s*[:=]?\s*["'(]?\s*$/i;
/** ...and after these keys ("v8: '14.3.127.18'", "chrome": "120.0.6099.71"), which are also ordinary words. */
const VERSION_KEY = /\b(?:node|npm|chrome|chromium|firefox|safari|edge|opera|android|ios|fw|browser|engine|os)["']?\s*[:=]\s*["']?\s*$/i;

type IpClass = 'public' | 'private' | 'localhost' | 'skip';

function classify4(s: string): IpClass {
  const [a, b, c] = s.split('.').map(Number);
  const v = s.split('.').reduce((acc, x) => acc * 256 + Number(x), 0);
  if (a === 127 || v === 0) return 'localhost';
  if (a === 255 && (v === 0xffffffff || ((~v >>> 0) & ((~v >>> 0) + 1)) === 0)) return 'skip'; // broadcast / netmask
  if (a === 0 || a >= 224) return 'skip'; // "this network", multicast, reserved
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'skip'; // documentation ranges
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}

const IPV6 = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9A-Fa-f]{1,4}|(?:\d{1,3}\.){3}\d{1,3})?(?:%[\w.-]+)?(?![\w:])|(?<![\w:.])::(?![\w:])/g;

export function parseIpv6(s: string): number[] | null {
  s = s.replace(/%.*$/, '');
  let v4: number[] = [];
  const m4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (m4) {
    const o = m4[1].split('.').map(Number);
    if (o.some((x) => x > 255)) return null;
    v4 = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, s.length - m4[1].length) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(':') : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const groups = [...head, ...tail];
  if (groups.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  const total = groups.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const nums = [...head.map((g) => parseInt(g, 16)), ...Array(halves.length === 2 ? 8 - total : 0).fill(0), ...tail.map((g) => parseInt(g, 16))];
  if (v4.length) {
    nums[6] = v4[0];
    nums[7] = v4[1];
  }
  return nums.length === 8 ? nums : null;
}

function classify6(n: number[]): IpClass {
  if (n.every((x) => x === 0)) return 'localhost';
  if (n.slice(0, 7).every((x) => x === 0) && n[7] === 1) return 'localhost';
  if (n[0] === 0x2001 && n[1] === 0x0db8) return 'skip';
  if ((n[0] & 0xff00) === 0xff00) return 'skip';
  if ((n[0] & 0xffc0) === 0xfe80 || (n[0] & 0xfe00) === 0xfc00) return 'private';
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return 'skip'; // IPv4-mapped: the IPv4 rule handles the inner address
  return 'public';
}

export const ipDetector: Detector = {
  id: 'network.ip',
  label: 'IP addresses (IPv4 / IPv6)',
  category: 'network',
  types: ['IP', 'IPV6'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, _cfg, ctx) {
    const t = doc.text;
    const out: Hit[] = [];
    const priv = opt(ctx.settings, 'ipPrivate', true);
    const local = opt(ctx.settings, 'ipLocalhost', false);
    for (const m of matchAll(IPV4, t)) {
      const cls = classify4(m[0]);
      if (cls === 'skip' || (cls === 'private' && !priv) || (cls === 'localhost' && !local)) continue;
      if (/\b0\d/.test(m[0].replace(/\./g, ' '))) continue; // leading zeros: ambiguous
      const before = t.slice(Math.max(0, m.index - 16), m.index);
      if (VERSION_WORD.test(before) || VERSION_KEY.test(before)) continue;
      // semver-style suffixes: 14.3.127.18-node.10, 1.2.3.4+build
      if (/^[-+][A-Za-z]/.test(t.slice(m.index + m[0].length, m.index + m[0].length + 2))) continue;
      out.push(mkHit('network.ip', 'IP', m.index, m.index + m[0].length, cls === 'public' ? 0.9 : 0.85, `${cls === 'private' ? 'private' : cls === 'localhost' ? 'loopback' : 'public'} IPv4 address`, 3, 'ipv4'));
    }
    if (t.includes('::') || /[0-9A-Fa-f]:[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,4}/.test(t)) {
      for (const m of matchAll(IPV6, t)) {
        const nums = parseIpv6(m[0]);
        if (!nums) continue;
        const cls = classify6(nums);
        if (cls === 'skip' || (cls === 'private' && !priv) || (cls === 'localhost' && !local)) continue;
        out.push(mkHit('network.ip', 'IPV6', m.index, m.index + m[0].length, 0.9, `${cls === 'private' ? 'private/link-local' : cls === 'localhost' ? 'loopback' : 'public'} IPv6 address`, 3, 'ipv6'));
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// MAC
// ---------------------------------------------------------------------------------------------

const MAC = /(?<![\w:-])(?:[0-9A-Fa-f]{2}([:-])){5}[0-9A-Fa-f]{2}(?![\w:-])|(?<![\w.])[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}(?![\w.])/g;

export const macDetector: Detector = {
  id: 'network.mac',
  label: 'MAC addresses',
  category: 'network',
  types: ['MAC'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc) {
    const out: Hit[] = [];
    for (const m of matchAll(MAC, doc.text)) {
      const hex = m[0].replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
      if (/^(.)\1+$/.test(hex) || hex.startsWith('00005e0053')) continue; // all same / RFC 7042 documentation range
      out.push(mkHit('network.mac', 'MAC', m.index, m.index + m[0].length, 0.9, 'MAC address', 3, 'mac'));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// hostnames under internal suffixes / company domains
// ---------------------------------------------------------------------------------------------

const LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';
const cache = new Map<string, RegExp[]>();

function hostRegexes(suffixes: string[], domains: string[]): RegExp[] {
  const key = suffixes.join(',') + '|' + domains.join(',');
  const hit = cache.get(key);
  if (hit) return hit;
  const out: RegExp[] = [];
  const sfx = suffixes.map((s) => s.replace(/^\./, '').toLowerCase()).filter((s) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(s));
  if (sfx.length) out.push(new RegExp(`(?<![\\w.-])(?:${LABEL}\\.)+(?:${sfx.map(escapeRegExp).join('|')})(?![\\w-]|\\.[\\w])`, 'gi'));
  const dom = domains.map((d) => d.trim().replace(/^\.+|\.+$/g, '').toLowerCase()).filter((d) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(d));
  if (dom.length) out.push(new RegExp(`(?<![\\w.-])(?:${LABEL}\\.)*(?:${dom.map(escapeRegExp).join('|')})(?![\\w-]|\\.[\\w])`, 'gi'));
  if (cache.size > 8) cache.clear();
  cache.set(key, out);
  return out;
}

export const hostDetector: Detector = {
  id: 'network.host',
  label: 'Hostnames under internal suffixes and company domains',
  category: 'network',
  types: ['HOST'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, cfg, ctx) {
    if (SENS_RANK[cfg.sensitivity] < SENS_RANK.balanced) return [];
    const out: Hit[] = [];
    const res = hostRegexes(opt(ctx.settings, 'hostSuffixes', DEFAULT_HOST_SUFFIXES), opt(ctx.settings, 'companyDomains', [] as string[]));
    for (const re of res) {
      for (const m of matchAll(re, doc.text)) {
        if (/^localhost(\.|$)/i.test(m[0])) continue;
        out.push(mkHit('network.host', 'HOST', m.index, m.index + m[0].length, 0.85, 'host name under an internal suffix or company domain', 2, 'host'));
      }
    }
    return out;
  },
};
