import type { Column } from '../types';
import { SegBuilder } from '../util';
import { isTableSep } from './csv';
import type { Part } from './part';

export type SubSegmenter = (code: string, info: string) => Part | null;

const FENCE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`\n]*$/;
const PREFIX = /^[ \t]{0,3}(?:>[ \t]?)*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)?/;
const INLINE = /(`+)([^`\n]*[^`\n])\1(?!`)|(!?\[)([^\]\n]*)(\]\()([^)\n]*)(\))|<(https?:\/\/[^>\s]+)>/g;

/** Splits a table row into trimmed cell ranges (absolute offsets). */
function tableCells(line: string, base: number): { s: number; e: number }[] {
  const cells: { s: number; e: number }[] = [];
  let start = 0;
  const len = line.length;
  const trimmed = line.trim();
  const lead = line.indexOf(trimmed);
  let i = lead;
  if (line[i] === '|') {
    i++;
    start = i;
  } else start = i;
  const endBound = lead + trimmed.length;
  for (; i <= endBound; i++) {
    if (i === endBound || (line[i] === '|' && line[i - 1] !== '\\')) {
      let s = start;
      let e = i;
      while (s < e && /\s/.test(line[s])) s++;
      while (e > s && /\s/.test(line[e - 1])) e--;
      if (!(i === endBound && s === e)) cells.push({ s: base + s, e: base + e });
      start = i + 1;
    }
  }
  void len;
  return cells;
}

export function segmentMarkdown(text: string, sub: SubSegmenter): Part {
  const b = new SegBuilder(text.length);
  const columns: Column[] = [];
  let errors = 0;
  const pairs: Part['pairs'] = [];
  const lines: { s: number; e: number }[] = [];
  let p = 0;
  while (p <= text.length) {
    let e = text.indexOf('\n', p);
    if (e < 0) e = text.length;
    lines.push({ s: p, e: text[e - 1] === '\r' && e > p ? e - 1 : e });
    p = e + 1;
    if (e >= text.length) break;
  }
  const line = (i: number) => text.slice(lines[i].s, lines[i].e);

  const proseRange = (s: number, e: number) => {
    if (e > s) b.add(s, e, 'prose');
  };

  const inline = (s: number, e: number) => {
    if (e - s > 4000) return proseRange(s, e);
    const seg = text.slice(s, e);
    let last = 0;
    INLINE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE.exec(seg))) {
      const ms = s + m.index;
      proseRange(s + last, ms);
      if (m[1]) {
        const ticks = m[1].length;
        b.add(ms, ms + ticks, 'structure');
        b.add(ms + ticks, ms + m[0].length - ticks, 'string', { quote: '`', vt: 'str' });
      } else if (m[3]) {
        let q = ms;
        b.add(q, q + m[3].length, 'structure');
        q += m[3].length;
        proseRange(q, q + m[4].length);
        q += m[4].length;
        b.add(q, q + m[5].length, 'structure');
        q += m[5].length;
        const urlPart = m[6];
        const ws = urlPart.search(/\s/);
        const urlLen = ws < 0 ? urlPart.length : ws;
        b.add(q, q + urlLen, 'string', { quote: '', vt: 'str', bare: true });
        q += urlLen;
        if (ws >= 0) proseRange(q, q + urlPart.length - urlLen);
        q += urlPart.length - urlLen;
        b.add(q, q + 1, 'structure');
      } else if (m[8]) {
        b.add(ms, ms + 1, 'structure');
        b.add(ms + 1, ms + 1 + m[8].length, 'string', { quote: '', vt: 'str', bare: true });
        b.add(ms + 1 + m[8].length, ms + m[0].length, 'structure');
      }
      last = m.index + m[0].length;
    }
    proseRange(s + last, e);
  };

  let li = 0;
  while (li < lines.length) {
    const L = lines[li];
    const txt = line(li);
    const fm = FENCE.exec(txt);
    if (fm) {
      const fenceCh = fm[2][0];
      const fenceLen = fm[2].length;
      let close = -1;
      for (let k = li + 1; k < lines.length; k++) {
        const t = line(k).trim();
        if (t.length >= fenceLen && t[0] === fenceCh && /^[`~]+$/.test(t)) {
          close = k;
          break;
        }
      }
      const bodyStart = li + 1 < lines.length ? lines[li + 1].s : text.length;
      const bodyEnd = close < 0 ? text.length : lines[close].s;
      if (bodyEnd > bodyStart) {
        const code = text.slice(bodyStart, bodyEnd);
        const part = sub(code, fm[3]);
        if (part) {
          errors += part.errors;
          for (const s of part.segments) {
            const { start, end, scope, ...rest } = s;
            b.add(start + bodyStart, end + bodyStart, scope, rest);
          }
          for (const pr of part.pairs)
            pairs.push({ ...pr, keyStart: pr.keyStart + bodyStart, keyEnd: pr.keyEnd + bodyStart, valStart: pr.valStart + bodyStart, valEnd: pr.valEnd + bodyStart });
          for (const c of part.columns)
            columns.push({
              ...c,
              headerStart: c.headerStart + bodyStart,
              headerEnd: c.headerEnd + bodyStart,
              cells: c.cells.map((x) => ({ start: x.start + bodyStart, end: x.end + bodyStart })),
            });
        } else b.add(bodyStart, bodyEnd, 'prose');
      }
      li = close < 0 ? lines.length : close + 1;
      continue;
    }
    // table
    if (txt.includes('|') && li + 1 < lines.length && isTableSep(line(li + 1))) {
      const hdr = tableCells(txt, L.s);
      const cols: Column[] = hdr.map((c, idx) => ({
        header: text.slice(c.s, c.e),
        index: idx,
        headerStart: c.s,
        headerEnd: c.e,
        cells: [],
      }));
      for (const c of hdr) b.add(c.s, c.e, 'key');
      li += 2;
      while (li < lines.length && line(li).includes('|') && line(li).trim()) {
        const cells = tableCells(line(li), lines[li].s);
        cells.forEach((c, idx) => {
          if (c.e > c.s) {
            b.add(c.s, c.e, 'prose');
            if (cols[idx]) cols[idx].cells.push({ start: c.s, end: c.e });
          }
        });
        li++;
      }
      columns.push(...cols);
      continue;
    }
    const pm = PREFIX.exec(txt);
    const pl = pm ? pm[0].length : 0;
    inline(L.s + pl, L.e);
    li++;
  }
  return { segments: b.finish(), pairs, columns, errors };
}
