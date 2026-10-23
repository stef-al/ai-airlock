import type { Pair } from '../types';
import { SegBuilder } from '../util';
import type { Part } from './part';

export type KvFlavour = 'env' | 'ini' | 'properties' | 'yaml-lite';

/**
 * Line oriented key/value segmenter for .env, INI, .properties, credential files and as a
 * tolerant fallback for broken YAML.
 */
export function segmentKv(text: string, flavour: KvFlavour): Part {
  const b = new SegBuilder(text.length);
  const pairs: Pair[] = [];
  const n = text.length;
  let pos = 0;
  let section = '';
  while (pos < n) {
    let eol = text.indexOf('\n', pos);
    if (eol < 0) eol = n;
    let lineEnd = eol;
    if (lineEnd > pos && text[lineEnd - 1] === '\r') lineEnd--;
    let i = pos;
    while (i < lineEnd && (text[i] === ' ' || text[i] === '\t')) i++;
    const c = text[i];
    if (i >= lineEnd) {
      pos = eol + 1;
      continue;
    }
    // comments
    if (c === '#' || (flavour === 'ini' && c === ';') || (flavour === 'properties' && c === '!')) {
      b.add(i, lineEnd, 'comment');
      pos = eol + 1;
      continue;
    }
    if (flavour === 'ini' && c === '[') {
      const close = text.indexOf(']', i);
      if (close > 0 && close < lineEnd) {
        b.add(i + 1, close, 'key');
        section = text.slice(i + 1, close);
        pos = eol + 1;
        continue;
      }
    }
    let k = i;
    const exp = /^export\s+/.exec(text.slice(i, Math.min(lineEnd, i + 10)));
    if (exp && flavour === 'env') k += exp[0].length;
    if (flavour === 'yaml-lite' && text[k] === '-' && /\s/.test(text[k + 1] ?? '')) {
      k += 2;
      while (k < lineEnd && text[k] === ' ') k++;
    }
    // key: up to first '=' or ':' (properties also whitespace)
    let ke = k;
    const sepSet = flavour === 'env' ? '=' : flavour === 'properties' ? '=: \t' : flavour === 'yaml-lite' ? ':' : '=:';
    while (ke < lineEnd && !sepSet.includes(text[ke])) ke++;
    if (ke >= lineEnd && flavour !== 'properties') {
      // no separator: a continuation line, a list item or plain text pasted along with the config.
      // It is still scanned; in broken YAML it stays bare-only so a placeholder cannot become syntax.
      let e = lineEnd;
      while (e > k && /\s/.test(text[e - 1])) e--;
      if (flavour === 'yaml-lite') b.add(k, e, 'config', { quote: '', vt: 'str', bare: true });
      else b.add(i, e, 'prose');
      pos = eol + 1;
      continue;
    }
    let keyEnd = ke;
    while (keyEnd > k && /\s/.test(text[keyEnd - 1])) keyEnd--;
    let vs = ke;
    if (vs < lineEnd) {
      while (vs < lineEnd && (text[vs] === ' ' || text[vs] === '\t')) vs++;
      if (text[vs] === '=' || text[vs] === ':') vs++;
      while (vs < lineEnd && (text[vs] === ' ' || text[vs] === '\t')) vs++;
    }
    if (keyEnd > k) b.add(k, keyEnd, 'key');
    if (vs >= lineEnd) {
      pos = eol + 1;
      continue;
    }
    let valStart = vs;
    let valEnd = lineEnd;
    let quote = '';
    const q = text[vs];
    let next = eol + 1;
    if ((q === '"' || q === "'") && flavour !== 'properties') {
      // find matching close quote (may span lines for env)
      let j = vs + 1;
      let found = -1;
      const limit = flavour === 'env' ? n : lineEnd;
      while (j < limit) {
        if (text[j] === '\\' && q === '"') {
          j += 2;
          continue;
        }
        if (text[j] === q) {
          found = j;
          break;
        }
        j++;
      }
      if (found > 0) {
        quote = q;
        valStart = vs + 1;
        valEnd = found;
        const le = text.indexOf('\n', found);
        next = (le < 0 ? n : le) + 1;
      }
    }
    if (!quote) {
      if (flavour === 'env' || flavour === 'yaml-lite') {
        const m = /\s#/.exec(text.slice(vs, lineEnd));
        if (m) valEnd = vs + m.index;
      }
      while (valEnd > valStart && /\s/.test(text[valEnd - 1])) valEnd--;
    }
    if (valEnd > valStart) {
      b.add(valStart, valEnd, 'config', { quote, vt: 'str', bare: !quote });
      pairs.push({
        key: text.slice(k, keyEnd),
        keyStart: k,
        keyEnd,
        valStart,
        valEnd,
        quote,
        kind: 'kv',
        path: section ? section + '.' + text.slice(k, keyEnd) : text.slice(k, keyEnd),
      });
    }
    pos = next;
  }
  return { segments: b.finish(), pairs, columns: [], errors: 0 };
}
