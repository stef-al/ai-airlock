import type { Pair } from '../types';
import { SegBuilder } from '../util';
import type { Part } from './part';

const KEY_ATTRS = new Set(['key', 'name', 'id', 'property', 'setting', 'param', 'var', 'variable']);
const VAL_ATTRS = new Set(['value', 'val', 'connectionstring', 'content', 'data', 'secret']);

interface Open {
  name: string;
  nameAttr?: string;
  textStart: number;
  textEnd: number;
  hasChild: boolean;
}

/** Tolerant XML/HTML scanner producing offsets (a real parser would lose positions). */
export function segmentXml(text: string): Part {
  const n = text.length;
  const b = new SegBuilder(n);
  const pairs: Pair[] = [];
  const stack: Open[] = [];
  let errors = 0;
  let i = 0;
  const flushText = (s: number, e: number) => {
    if (e <= s) return;
    const raw = text.slice(s, e);
    if (!raw.trim()) return;
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const ts = s + lead;
    const te = e - trail;
    b.add(ts, te, 'config', { vt: 'str' });
    const top = stack[stack.length - 1];
    if (top) {
      top.textStart = ts;
      top.textEnd = te;
    }
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      flushText(i, n);
      break;
    }
    flushText(i, lt);
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      const end = e < 0 ? n : e + 3;
      b.add(lt, end, 'comment');
      i = end;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      const cs = lt + 9;
      const ce = e < 0 ? n : e;
      b.add(cs, ce, 'config', { vt: 'str' });
      const top = stack[stack.length - 1];
      if (top) {
        top.textStart = cs;
        top.textEnd = ce;
      }
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const e = text.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (text[lt + 1] === '/') {
      const e = text.indexOf('>', lt);
      const end = e < 0 ? n : e;
      const name = text.slice(lt + 2, end).trim();
      b.add(lt + 2, lt + 2 + name.length, 'key');
      const top = stack.pop();
      if (!top || top.name !== name) errors++;
      if (top && !top.hasChild && top.textEnd > top.textStart && top.name === name) {
        const key = top.nameAttr ?? top.name;
        pairs.push({
          key,
          keyStart: lt + 2,
          keyEnd: lt + 2 + name.length,
          valStart: top.textStart,
          valEnd: top.textEnd,
          quote: '',
          kind: 'element',
        });
      }
      i = e < 0 ? n : e + 1;
      continue;
    }
    // start tag
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(text[j])) j++;
    const name = text.slice(lt + 1, j);
    if (!name || !/^[A-Za-z_]/.test(name)) {
      // stray '<' (e.g. a comparison in prose)
      i = lt + 1;
      continue;
    }
    b.add(lt + 1, j, 'key');
    const attrs: { name: string; ns: number; ne: number; vs: number; ve: number; q: string }[] = [];
    let selfClose = false;
    while (j < n) {
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClose = true;
        j += 2;
        break;
      }
      if (text[j] === '<') break; // unterminated tag
      const ns = j;
      while (j < n && !/[\s=/>]/.test(text[j])) j++;
      const ne = j;
      if (ne === ns) {
        j++;
        continue;
      }
      b.add(ns, ne, 'key');
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === '=') {
        j++;
        while (j < n && /\s/.test(text[j])) j++;
        const q = text[j];
        if (q === '"' || q === "'") {
          const e = text.indexOf(q, j + 1);
          const ve = e < 0 ? n : e;
          const vs = j + 1;
          b.add(vs, ve, 'config', { quote: q, vt: 'str' });
          attrs.push({ name: text.slice(ns, ne), ns, ne, vs, ve, q });
          j = e < 0 ? n : e + 1;
        } else {
          const vs = j;
          while (j < n && !/[\s>]/.test(text[j]) && !(text[j] === '/' && text[j + 1] === '>')) j++;
          b.add(vs, j, 'config', { quote: '', vt: 'str', bare: true });
          attrs.push({ name: text.slice(ns, ne), ns, ne, vs, ve: j, q: '' });
        }
      }
    }
    let nameAttr: string | undefined;
    for (const a of attrs) {
      pairs.push({ key: a.name, keyStart: a.ns, keyEnd: a.ne, valStart: a.vs, valEnd: a.ve, quote: a.q, kind: 'kv' });
    }
    const kA = attrs.find((a) => KEY_ATTRS.has(a.name.toLowerCase()));
    if (kA) {
      nameAttr = text.slice(kA.vs, kA.ve);
      const vA = attrs.find((a) => a !== kA && VAL_ATTRS.has(a.name.toLowerCase()));
      if (vA) {
        pairs.push({ key: nameAttr, keyStart: kA.vs, keyEnd: kA.ve, valStart: vA.vs, valEnd: vA.ve, quote: vA.q, kind: 'element' });
      }
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.hasChild = true;
    if (!selfClose && !/^(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)$/i.test(name)) {
      stack.push({ name, nameAttr, textStart: 0, textEnd: 0, hasChild: false });
    }
    i = j;
  }
  errors += stack.length;
  return { segments: b.finish(), pairs, columns: [], errors };
}
