// The text of one PDF page with a box per character, in page units (points, rotation applied, y
// down): the text layer (exact text; character positions estimated within each item), OCR words
// for what the text layer lacks (scans, text inside images, text drawn as outlines), and the
// contents of annotations and QR codes. Pure: no DOM, no pdf.js.
import { faceRegion, HEAD, ocrText, TAIL, type OcrText } from './ocrdoc';
import type { Box, OcrWord } from './ocrTypes';
import { letters } from '../engine/segment/tables';

/** A text item of pdf.js getTextContent(), placed on the page. */
export interface LayerItem {
  str: string;
  /** Util.transform(viewport.transform, item.transform) */
  tx: number[];
  /** advance width in page units */
  width: number;
  /** the item ends a line */
  eol: boolean;
  /** font ascent and descent as fractions of the font size (descent negative) */
  ascent?: number;
  descent?: number;
  /** generic family from pdf.js (sans-serif, serif, monospace) */
  family?: string;
}

/** Width of a character in some font of the family (any unit: only ratios are used). */
export type Measure = (ch: string, family: string) => number;

type V = [number, number];

export interface Placed {
  item: LayerItem;
  /** baseline origin, advance direction, glyph up direction */
  o: V;
  u: V;
  v: V;
  /** font size and advance width in page units */
  fh: number;
  w: number;
  chars: Box[];
  box: Box;
}

const aabb = (ps: V[]): Box => [Math.min(...ps.map((p) => p[0])), Math.min(...ps.map((p) => p[1])), Math.max(...ps.map((p) => p[0])), Math.max(...ps.map((p) => p[1]))];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const along = (p: Placed, t: number, s: number): V => [p.o[0] + p.u[0] * t + p.v[0] * s, p.o[1] + p.u[1] * t + p.v[1] * s];

/**
 * Where an item's characters are. pdf.js gives the item's position and width, not glyph positions:
 * the width is shared by measured character widths (a similar font of the same family), or evenly.
 */
export function placeItem(item: LayerItem, measure?: Measure): Placed {
  const [a, b, c, d, e, f] = item.tx;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  const fh = sy > 0 ? sy : sx || 1;
  const u: V = sx > 0 ? [a / sx, b / sx] : [1, 0];
  // the glyphs' up direction: (0, -1) for upright text on an upright page
  const v: V = sy > 0 ? [c / sy, d / sy] : [u[1], -u[0]];
  const n = item.str.length;
  const w = item.width > 0 ? item.width : n * 0.5 * fh;
  const asc = Math.max(item.ascent ?? 0.8, 0.7) * fh;
  const desc = Math.min(item.descent ?? -0.2, -0.15) * fh;
  const p: Placed = { item, o: [e, f], u, v, fh, w, chars: [], box: [0, 0, 0, 0] };
  const widths = [...Array(n).keys()].map((i) => (measure ? Math.max(0, measure(item.str[i], item.family ?? 'sans-serif')) : 1));
  const total = widths.reduce((x, y) => x + y, 0);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const t1 = t + (total > 0 ? widths[i] / total : 1 / n) * w;
    p.chars.push(aabb([along(p, t, desc), along(p, t1, desc), along(p, t, asc), along(p, t1, asc)]));
    t = t1;
  }
  p.box = aabb([along(p, 0, desc), along(p, w, desc), along(p, 0, asc), along(p, w, asc)]);
  return p;
}

interface Line {
  parts: { p: Placed; space: boolean }[];
}

/** Items in content order become lines: a break at end of line, when the baseline moves, or when the text goes back. */
function buildLines(items: Placed[]): Line[] {
  const lines: Line[] = [];
  let prev: Placed | null = null;
  let eol = false;
  for (const p of items) {
    if (!p.item.str) {
      eol ||= p.item.eol;
      continue;
    }
    if (!prev) lines.push({ parts: [{ p, space: false }] });
    else {
      const end: V = along(prev, prev.w, 0);
      const ahead = dot(sub(p.o, end), prev.u);
      const across = dot(sub(p.o, prev.o), prev.v);
      if (eol || prev.item.eol || Math.abs(across) > 0.5 * prev.fh || ahead < -prev.fh) lines.push({ parts: [{ p, space: false }] });
      else {
        const space = ahead > 0.15 * prev.fh && !/\s$/.test(prev.item.str) && !/^\s/.test(p.item.str);
        lines[lines.length - 1].parts.push({ p, space });
      }
    }
    prev = p;
    eol = false;
  }
  return lines;
}

const upright = (p: Placed) => p.u[0] > 0.99;
const mono = (p: Placed) => p.item.family === 'monospace';

const lastOf = (l: Line) => l.parts[l.parts.length - 1].p;
const letter = (ch: string) => /\p{L}/u.test(ch);

/**
 * A long line printed with wrapping (logs, CSV, code, long tokens) is broken where the column
 * ends, often in the middle of a token: such breaks are joined.
 * - A candidate ends within about a character of the column edge (several lines end there), with
 *   no space on either side of the break, and the next line starts at the left edge.
 * - It is joined when the boundary looks like the middle of a token (not two words of prose, not
 *   the end of a statement or a tag), or when enough candidates of a column do: then the text was
 *   printed breaking anywhere.
 */
function softWraps(lines: Line[], strs: string[], table: boolean[]): boolean[] {
  const no = lines.map(() => false);
  if (lines.length < 2) return no;
  // table rows are never wrapped lines, and their width says nothing about the text column
  const endX = lines.map((l, i) => (upright(lastOf(l)) && !table[i] ? lastOf(l).box[2] : NaN));
  const edge = Math.max(0, ...endX.filter((x) => !Number.isNaN(x)));
  const atEdge = lines.map((l, i) => !Number.isNaN(endX[i]) && edge - endX[i] <= lastOf(l).fh);
  const column = atEdge.filter(Boolean).length >= 3;
  const startX = lines.map((l, i) => (upright(l.parts[0].p) && !table[i] ? l.parts[0].p.o[0] : NaN));
  const left = Math.min(...startX.filter((x) => !Number.isNaN(x)));
  const candidate = lines.map((l, i) => {
    if (i === 0 || !atEdge[i - 1] || table[i]) return false;
    const prev = lastOf(lines[i - 1]);
    const cw = prev.w / Math.max(1, prev.item.str.length);
    const a = strs[i - 1];
    const b = strs[i];
    return edge - endX[i - 1] <= 1.5 * cw && startX[i] - left <= cw && !!a && !!b && !/\s$/.test(a) && !/^\s/.test(b);
  });
  const midToken = lines.map((_, i) => {
    if (!candidate[i]) return false;
    const a = strs[i - 1];
    const b = strs[i];
    const tail = /\S+$/.exec(a)![0];
    const head = /^\S+/.exec(b)![0];
    const x = a[a.length - 1];
    const y = b[0];
    const alnum = (ch: string) => /[\p{L}\d]/u.test(ch);
    // never across structure: a line that ends with > } ; " or a next one that starts with < { [ #
    if (/[>}\]);"'`|]/.test(x) || /[<{[(#"'`|]/.test(y)) return false;
    // a capitalised word starts a new sentence or a new row (…acme.com | Grafana, J3nkins#Prod | See)
    if (/^\p{Lu}\p{Ll}+[,.;:!?]?$/u.test(head)) return false;
    const sure =
      // digits or token punctuation on both sides (10.|0.0.5, 3815|0982, Pw#|31)
      (!letter(x) && !letter(y) && (/\d/.test(x + y) || /[-_./:=+%~]/.test(x))) ||
      (alnum(x) && /^[=:/@._,&?#-]\S/.test(b)) ||
      // inside an email, URL, path or assignment (globex-c|orp.net, Passwor|d=)
      (alnum(x) && alnum(y) && /[@/\\_=]/.test(tail.slice(1)));
    // digits around the break are weaker evidence: only where several lines end at the edge, or a long token
    const digits = /\d/.test(tail + head) && tail.length >= 6 && head.length >= 2;
    const long = tail.length >= 16 && head.length >= 8 && /\d/.test(tail) && /\d/.test(head);
    return sure || (column ? digits : long);
  });
  const sure = midToken.filter(Boolean).length;
  const all = candidate.filter(Boolean).length;
  const anywhere = column && sure >= 1 && sure / all >= 0.3;
  // even then a sentence end before a capital is a real line end
  return anywhere ? candidate.map((c, i) => midToken[i] || (c && !(/[.!?]$/.test(strs[i - 1]) && /^\p{Lu}/u.test(strs[i])))) : midToken;
}

/** a jump of at least this many font heights between two items of a line separates table cells */
const CELL_GAP = 1;

interface Cell {
  parts: Line['parts'];
  x0: number;
  x1: number;
}

/**
 * The cells of a line of upright proportional text: it is split where the text jumps by a font
 * height or more (pdf.js marks such a jump with a wide whitespace item).
 */
function cellsOf(l: Line): Cell[] {
  if (!l.parts.every(({ p }) => upright(p) && !mono(p))) return [];
  const cells: Cell[] = [];
  let cur: Cell | null = null;
  let end = -Infinity;
  for (const part of l.parts) {
    const { p } = part;
    if (!p.item.str.trim()) {
      if (p.w >= CELL_GAP * p.fh) cur = null;
      else if (cur) cur.parts.push(part);
    } else {
      if (cur && p.o[0] - end >= CELL_GAP * p.fh) cur = null;
      if (cur) {
        cur.parts.push(part);
        cur.x1 = p.box[2];
      } else {
        cur = { parts: [{ p, space: false }], x0: p.box[0], x1: p.box[2] };
        cells.push(cur);
      }
    }
    end = p.o[0] + p.w;
  }
  return cells;
}

const cellText = (c: Cell) => c.parts.map(({ p, space }) => (space ? ' ' : '') + p.item.str).join('').trim();

interface Table {
  /** line index and cells of each row */
  rows: { line: number; cells: Cell[] }[];
  /** per row, the column of each cell; columns are ordered left to right */
  cols: number[][];
  width: number;
}

/** columns of a table: a cell joins the column whose left or right edge it shares, or starts a new one */
function columns(rows: Cell[][], tol: number): { cols: number[][]; width: number } {
  const anchors: { x0: number; x1: number }[] = [];
  const raw = rows.map((cs) =>
    cs.map((c) => {
      let k = anchors.findIndex((a) => Math.abs(a.x0 - c.x0) <= tol || Math.abs(a.x1 - c.x1) <= tol);
      if (k < 0) k = anchors.push({ x0: c.x0, x1: c.x1 }) - 1;
      return k;
    }),
  );
  const order = anchors.map((a, k) => [a.x0, k]).sort((a, b) => a[0] - b[0]).map(([, k]) => k);
  const rank = new Map(order.map((k, i) => [k, i]));
  return { cols: raw.map((r) => r.map((k) => rank.get(k)!)), width: anchors.length };
}

/**
 * Tables: consecutive lines of two or more cells, each row sharing at least two cell edges with the
 * rows above (not prose set in two columns: some column has short cells).
 */
function findTables(lines: Line[]): Table[] {
  const out: Table[] = [];
  let rows: { line: number; cells: Cell[] }[] = [];
  const close = () => {
    if (rows.length >= 2) {
      const tol = Math.max(1.5, 0.3 * rows[0].cells[0].parts[0].p.fh);
      const { cols, width } = columns(
        rows.map((r) => r.cells),
        tol,
      );
      const byCol: number[][] = [...Array(width)].map(() => []);
      rows.forEach((r, i) => r.cells.forEach((c, k) => byCol[cols[i][k]].push(cellText(c).length)));
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
      if (byCol.some((xs) => xs.length >= 2 && median(xs) <= 25)) out.push({ rows, cols, width });
    }
    rows = [];
  };
  lines.forEach((l, i) => {
    const cells = cellsOf(l);
    // a list (a bullet or number, then the text at a tab stop) is no table
    if (cells.length < 2 || /^(?:[•◦▪▫‣⁃●○■□–—*-]|\(?\d{1,3}[.)]|\(?[a-z][.)])$/u.test(cellText(cells[0]))) return close();
    if (rows.length) {
      const prev = rows[rows.length - 1];
      const fh = l.parts[0].p.fh;
      const tol = Math.max(1.5, 0.3 * fh);
      const dy = l.parts[0].p.o[1] - lines[prev.line].parts[0].p.o[1];
      const seen = rows.flatMap((r) => r.cells);
      const shared = cells.filter((c) => seen.some((s) => Math.abs(s.x0 - c.x0) <= tol || Math.abs(s.x1 - c.x1) <= tol)).length;
      if (dy > 0 && dy <= 4 * fh && shared >= 2) {
        rows.push({ line: i, cells });
        return;
      }
      close();
    }
    rows.push({ line: i, cells });
  });
  close();
  return out;
}

/**
 * The text layer as text with character boxes. Monospace lines keep their indentation (YAML,
 * code); lines broken in the middle of a token are joined; tables become Markdown tables under
 * column letters, so values get their column.
 */
export function layerText(items: Placed[]): OcrText {
  const lines = buildLines(items);
  const strs = lines.map((l) => l.parts.map(({ p, space }) => (space ? ' ' : '') + p.item.str).join(''));
  const rowOf = new Map<number, { t: Table; r: number }>();
  for (const t of findTables(lines)) t.rows.forEach((row, r) => rowOf.set(row.line, { t, r }));
  const joined = softWraps(
    lines,
    strs,
    lines.map((_, i) => rowOf.has(i)),
  );
  const text: string[] = [];
  const boxes: (Box | null)[] = [];
  const ln: number[] = [];
  const put = (ch: string, b: Box | null, l: number) => {
    text.push(ch);
    boxes.push(b);
    ln.push(b ? l : -1);
  };
  // left edge of monospace text: indentation is counted from there
  const starts = lines.map((l) => l.parts[0].p).filter((p) => mono(p) && upright(p));
  const margin = starts.length ? Math.min(...starts.map((p) => p.o[0])) : 0;
  const ends: { last: number; x: number; h: number; next: number }[] = [];
  const lit = (s: string) => {
    for (const ch of s) put(ch, null, -1);
  };
  const emit = (parts: Line['parts'], i: number, cell: boolean) => {
    for (const { p, space } of parts) {
      if (space) put(' ', null, -1);
      // a | inside a cell would add a column
      for (let k = 0; k < p.item.str.length; k++) put(cell && p.item.str[k] === '|' ? '¦' : p.item.str[k], /\s/.test(p.item.str[k]) ? null : p.chars[k], i);
    }
  };
  lines.forEach((l, i) => {
    const first = l.parts[0].p;
    if (i > 0 && !joined[i]) {
      put('\n', null, -1);
      if (mono(first) && upright(first) && first.item.str.length) {
        const cw = first.w / first.item.str.length;
        const n = cw > 0 ? Math.min(80, Math.round((first.o[0] - margin) / cw)) : 0;
        for (let k = 0; k < n; k++) put(' ', null, -1);
      }
    }
    const row = rowOf.get(i);
    if (row) {
      const { t, r } = row;
      const sep = '\n|' + ' --- |'.repeat(t.width);
      // column letters as the header: the segmenter decides whether the first row names the columns
      if (r === 0) lit('| ' + letters(t.width).join(' | ') + ' |' + sep + '\n');
      lit('|');
      for (let c = 0; c < t.width; c++) {
        lit(' ');
        t.rows[r].cells.forEach((cell, k) => {
          if (t.cols[r][k] !== c) return;
          if (text[text.length - 1] !== ' ') lit(' ');
          // the cell's own characters, without the spaces around them
          const parts = cell.parts.filter(({ p }) => p.item.str.trim());
          emit(cell.parts.slice(cell.parts.indexOf(parts[0]), cell.parts.lastIndexOf(parts[parts.length - 1]) + 1), i, true);
        });
        lit(' |');
      }
      if (i > 0) ends[i - 1].next = -1;
      ends.push({ last: text.length - 1, x: NaN, h: first.fh, next: -1 });
      return;
    }
    const lineStart = text.length;
    emit(l.parts, i, false);
    const last = lastOf(l);
    if (i > 0) ends[i - 1].next = joined[i] ? -1 : lineStart;
    ends.push({ last: text.length - 1, x: upright(last) ? last.box[2] : NaN, h: last.fh, next: -1 });
  });
  // a token that ends at the right edge of the text may continue on the next line (as in ocrText)
  const cont: { at: number; start: number; end: number }[] = [];
  const edge = Math.max(0, ...ends.map((e) => e.x).filter((x) => !Number.isNaN(x)));
  const atEdge = ends.map((e) => !Number.isNaN(e.x) && edge - e.x <= e.h);
  if (atEdge.filter(Boolean).length >= 3) {
    const str = text.join('');
    ends.forEach((e, i) => {
      if (!atEdge[i] || e.next < 0) return;
      const lineText = str.slice(str.lastIndexOf('\n', e.last) + 1, e.last + 1);
      const tail = TAIL.exec(lineText)?.[0] ?? '';
      const nl = str.indexOf('\n', e.next);
      const nextLine = str.slice(e.next, nl < 0 ? str.length : nl);
      const head = HEAD.exec(nextLine)?.[0] ?? '';
      if (tail.length < 8 || !head || /[.,;:]$/.test(lineText)) return;
      const start = str.indexOf(head, e.next);
      cont.push({ at: e.last, start, end: start + head.length });
    });
  }
  return { text: text.join(''), boxes, lines: ln, cont };
}

/** Concatenate texts (line numbers and continuation offsets shifted); `at` is where each part starts (-1 if empty). */
export function joinTexts(parts: OcrText[], sep = '\n'): { joined: OcrText; at: number[] } {
  const out: OcrText = { text: '', boxes: [], lines: [], cont: [] };
  const starts: number[] = [];
  let lineBase = 0;
  for (const p of parts) {
    if (!p.text) {
      starts.push(-1);
      continue;
    }
    if (out.text) {
      out.text += sep;
      for (let i = 0; i < sep.length; i++) {
        out.boxes.push(null);
        out.lines.push(-1);
      }
    }
    const at = out.text.length;
    starts.push(at);
    out.text += p.text;
    out.boxes.push(...p.boxes);
    let max = -1;
    for (const l of p.lines) {
      out.lines.push(l < 0 ? -1 : l + lineBase);
      if (l > max) max = l;
    }
    for (const c of p.cont ?? []) out.cont!.push({ at: c.at + at, start: c.start + at, end: c.end + at });
    lineBase += max + 1;
  }
  return { joined: out, at: starts };
}

/** Annotation contents: visible ones (form values, text boxes) cover their rectangle, hidden ones (comments, links) none. */
export interface PageAnnot {
  label: string;
  text: string;
  box: Box | null;
}

export interface PageInput {
  items: Placed[];
  /** OCR words in page units */
  ocr: OcrWord[];
  annots: PageAnnot[];
  qr: { text: string; box: Box }[];
  /** faces found on the page raster (page units) */
  faces?: { box: Box; score: number }[];
  width: number;
}

export interface PageText {
  text: OcrText;
  /** where each QR code's content is in the text (always masked) */
  qr: { start: number; end: number }[];
  /** where each face's line is in the text, with the detector's score */
  faces: { start: number; end: number; score: number }[];
  /** OCR words that were added (text the text layer does not have) */
  ocrWords: number;
}

const center = (b: Box): V => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const inside = (p: V, b: Box, m: number) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Text layer first; then the OCR words no text item, visible annotation or QR code covers (an
 * invisible OCR layer of a scanned PDF is a text layer, so its words are not doubled); then one
 * line per annotation and QR code.
 */
export function pageText(p: PageInput): PageText {
  const layer = layerText(p.items);
  const textBoxes = p.items.filter((i) => i.item.str.trim()).map((i) => i.box);
  const regionBoxes = [...p.annots.map((a) => a.box).filter((b): b is Box => !!b), ...p.qr.map((q) => q.box)];
  const words = p.ocr.filter((w) => w.text.trim() && !textBoxes.some((b) => inside(center(w.box), b, 2)) && !regionBoxes.some((b) => inside(center(w.box), b, 0)));
  const read = ocrText({ text: '', conf: 0, words }, [], p.width);
  // regions: every character of a line maps to the region's box
  const reg: OcrText = { text: '', boxes: [], lines: [], cont: [] };
  const qrAt: { start: number; end: number }[] = [];
  let n = 0;
  const line = (label: string, content: string, box: Box | null) => {
    if (reg.text) {
      reg.text += '\n';
      reg.boxes.push(null);
      reg.lines.push(-1);
    }
    const s = `${label}: ${content}`;
    const start = reg.text.length + label.length + 2;
    reg.text += s;
    for (let i = 0; i < s.length; i++) {
      reg.boxes.push(box);
      reg.lines.push(box ? n : -1);
    }
    n++;
    return { start, end: reg.text.length };
  };
  for (const q of p.qr) qrAt.push(line('QR code', oneLine(q.text), q.box));
  // faces do not drop the words under them (a wrong box must not hide text from detection)
  const faceAt = (p.faces ?? []).map((f) => ({ ...line('Face', faceRegion(f.box, f.score).text, f.box), score: f.score }));
  for (const a of p.annots) if (oneLine(a.text)) line(a.label, oneLine(a.text), a.box);
  const { joined, at } = joinTexts([layer, read, reg]);
  const shift = <T extends { start: number; end: number }>(s: T): T => ({ ...s, start: s.start + at[2], end: s.end + at[2] });
  return { text: joined, qr: qrAt.map(shift), faces: faceAt.map(shift), ocrWords: words.length };
}

/** The whole document as one text: a marker line before each page when there are several. */
export function joinPages(pages: string[]): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  pages.forEach((t, i) => {
    if (pages.length > 1) text += `${i ? '\n\n' : ''}=== Page ${i + 1} ===\n`;
    offsets.push(text.length);
    text += t;
  });
  return { text, offsets };
}
