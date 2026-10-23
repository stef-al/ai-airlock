import type { Column } from '../types';
import { SegBuilder } from '../util';
import type { Part } from './part';

export interface Cell {
  start: number;
  end: number;
  quoted: boolean;
}

/** Pick the most plausible delimiter by consistency over the first lines. */
export function sniffDelimiter(text: string): string | null {
  const lines = text.split('\n', 30).filter((l) => l.trim());
  if (lines.length < 2) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => {
      let c = 0;
      let inQ = false;
      for (let i = 0; i < l.length; i++) {
        if (l[i] === '"') inQ = !inQ;
        else if (!inQ && l[i] === d) c++;
      }
      return c;
    });
    const first = counts[0];
    if (first === 0) continue;
    const same = counts.filter((c) => c === first).length / counts.length;
    if (same >= 0.8 && same * first > bestScore) {
      bestScore = same * first;
      best = d;
    }
  }
  return best;
}

export function parseCsv(text: string, delim: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] === '"') {
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) {
          j = n;
          break;
        }
        if (text[q + 1] === '"') {
          j = q + 2;
          continue;
        }
        j = q;
        break;
      }
      row.push({ start: i + 1, end: j, quoted: true });
      i = j + 1;
      while (i < n && text[i] !== delim && text[i] !== '\n' && text[i] !== '\r') i++; // trailing junk
    } else {
      let j = i;
      while (j < n && text[j] !== delim && text[j] !== '\n' && text[j] !== '\r') j++;
      row.push({ start: i, end: j, quoted: false });
      i = j;
    }
    if (i >= n) {
      rows.push(row);
      row = [];
      break;
    }
    if (text[i] === delim) {
      i++;
      if (i >= n) row.push({ start: n, end: n, quoted: false });
      continue;
    }
    // newline
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else i++;
    rows.push(row);
    row = [];
  }
  if (row.length) rows.push(row);
  return rows.filter((r) => !(r.length === 1 && r[0].start === r[0].end));
}

const NUMERIC = /^[-+]?[\d.,\s]+%?$/;

export function looksLikeHeader(text: string, rows: Cell[][]): boolean {
  if (rows.length < 2) return false;
  const h = rows[0];
  if (h.length < 2) return false;
  for (const c of h) {
    const v = text.slice(c.start, c.end).trim();
    if (!v || v.length > 60 || NUMERIC.test(v) || /@/.test(v)) return false;
  }
  return true;
}

export function segmentCsv(text: string, delim?: string): Part {
  const d = delim ?? sniffDelimiter(text) ?? ',';
  const rows = parseCsv(text, d);
  const b = new SegBuilder(text.length);
  const hasHeader = looksLikeHeader(text, rows);
  const columns: Column[] = [];
  rows.forEach((row, r) => {
    row.forEach((c, ci) => {
      const header = hasHeader && r === 0;
      if (header) {
        b.add(c.start, c.end, 'key');
        columns[ci] = {
          header: text.slice(c.start, c.end).trim(),
          index: ci,
          headerStart: c.start,
          headerEnd: c.end,
          cells: [],
        };
      } else {
        b.add(c.start, c.end, 'config', { quote: c.quoted ? '"' : '', vt: 'str' });
        if (hasHeader && columns[ci] && c.end > c.start) columns[ci].cells.push({ start: c.start, end: c.end });
      }
    });
  });
  return { segments: b.finish(), pairs: [], columns: columns.filter(Boolean), errors: 0 };
}

/** Parse a GitHub-flavoured Markdown table block starting at lines[start]; returns end line index. */
export function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-') && line.includes('|');
}
