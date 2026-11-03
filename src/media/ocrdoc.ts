// Text read from an image, with the box of every character, so findings in the text become
// rectangles to paint over. Pure: no DOM, runs in Node for tests.
import type { Box, OcrResult, OcrWord } from './ocrTypes';

export interface OcrText {
  text: string;
  /** box of each character of `text`; null for separators (spaces, line breaks) */
  boxes: (Box | null)[];
  /** visual line of each character (-1 for separators) */
  lines: number[];
  /**
   * A token-like word ends a line at the right edge and the next line starts with one: the token
   * may continue there. `at` is the last character of the line, start/end the next line's first word.
   */
  cont?: { at: number; start: number; end: number }[];
}

export interface Region {
  /** text that stands for the region, e.g. the decoded content of a QR code */
  text: string;
  box: Box;
  label: string;
}

/** a token's characters at the end of a line and at the start of the next */
export const TAIL = /[A-Za-z0-9+/=_.:~%@-]{8,}$/;
export const HEAD = /^[A-Za-z0-9+/=_.:~%@-]{3,}/;
/**
 * OCR reads straight quotes as typographic ones and a "c" as a cent sign: mapped back one for one
 * (offsets do not move)
 */
const NORMAL: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '´': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '–': '-', '—': '-', '¢': 'c' };
const normal = (ch: string) => NORMAL[ch] ?? ch;

/** Character boxes of a word: Tesseract's symbol boxes, or the word box split evenly. */
function charBoxes(w: OcrWord): Box[] {
  const chars = [...w.text];
  const sym = w.chars;
  if (sym.length === chars.length) return sym.map((c) => c.box);
  const [x0, y0, x1, y1] = w.box;
  const step = (x1 - x0) / Math.max(1, chars.length);
  return chars.map((_, i) => [x0 + i * step, y0, x0 + (i + 1) * step, y1] as Box);
}

const QUOTE = /['"]/;
const OPENS_AFTER = /[\s=(,:[{]/;

/**
 * OCR often gets one quote of a pair wrong ('Bl1ng!Ap9") or doubles an opening one (''Rep0rt'):
 * per line, a closing quote takes its opening quote's character, and a doubled opening quote before
 * a value becomes a space. One character for one, so no box moves. Apostrophes in words are left.
 */
function repairQuotes(c: string[]): void {
  let open = -1;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch === '\n') {
      open = -1;
      continue;
    }
    const prev = i > 0 ? c[i - 1] : '\n';
    const next = c[i + 1] ?? '\n';
    // quotes read as other glyphs: ® closing an open quote ("admin®,), * opening one (*hunter22x')
    if (ch === '®' && open >= 0 && /\w/.test(prev) && /[\s,;)\]]/.test(next)) {
      c[i] = c[open];
      open = -1;
      continue;
    }
    if (ch === '*' && open < 0 && OPENS_AFTER.test(prev) && /[A-Za-z0-9]/.test(next)) {
      let j = i + 1;
      while (j < c.length && c[j] !== '\n' && !QUOTE.test(c[j])) j++;
      if (QUOTE.test(c[j] ?? '') && /[\s,;)\]]/.test(c[j + 1] ?? '\n') && !/\s/.test(c.slice(i + 1, j).join(''))) {
        c[i] = c[j];
        open = i;
        continue;
      }
    }
    if (!QUOTE.test(ch)) continue;
    if (/\w/.test(prev) && /\w/.test(next)) continue; // don't, it's
    if (open < 0) {
      if (!OPENS_AFTER.test(prev) && prev !== '\n') continue;
      if (QUOTE.test(next) && /[A-Za-z0-9]/.test(c[i + 2] ?? '')) {
        c[i] = ' ';
        open = i + 1;
        i++;
        continue;
      }
      open = i;
    } else {
      c[i] = c[open];
      open = -1;
    }
  }
}

/**
 * Words in reading order become lines separated by '\n' and words separated by one space. A long
 * token that ends at the right edge of the text and continues at the start of the next line was
 * wrapped: the two parts are joined so it is detected as one value.
 */
export function ocrText(r: OcrResult, regions: Region[] = [], width = 0): OcrText {
  const text: string[] = [];
  const boxes: (Box | null)[] = [];
  const lines: number[] = [];
  const byLine = new Map<number, OcrWord[]>();
  // OCR reads the modules of a QR code as garbage words: those are dropped (the code is covered)
  const inRegion = (w: OcrWord) => regions.some((g) => (w.box[0] + w.box[2]) / 2 >= g.box[0] && (w.box[0] + w.box[2]) / 2 <= g.box[2] && (w.box[1] + w.box[3]) / 2 >= g.box[1] && (w.box[1] + w.box[3]) / 2 <= g.box[3]);
  for (const w of r.words) if (w.text.trim() && !inRegion(w)) (byLine.get(w.line) ?? byLine.set(w.line, []).get(w.line)!).push(w);
  const order = [...byLine.keys()].sort((a, b) => a - b);
  // Wrapped text has a column edge: several lines end at the same x. Only then can a line that
  // ends there be the first part of a token that continues on the next line.
  const ends = order.map((ln) => byLine.get(ln)!.at(-1)!.box[2]);
  const edge = Math.max(0, ...ends);
  const lh = (ln: number) => byLine.get(ln)!.at(-1)!.box[3] - byLine.get(ln)!.at(-1)!.box[1];
  const atEdge = order.map((ln, i) => edge - ends[i] <= lh(ln));
  // a line that ends at the image's right side is cut there too (a terminal, a narrow window)
  const wrapping = atEdge.filter(Boolean).length >= 3 || (width > 0 && edge >= 0.93 * width);
  const cont: { at: number; start: number; end: number }[] = [];
  // one array element per UTF-16 unit, like the offsets of findings in the joined text
  const push = (s: string, b: Box | null, line: number) => {
    for (let u = 0; u < s.length; u++) {
      text.push(normal(s[u]));
      boxes.push(b);
      lines.push(b ? line : -1);
    }
  };
  order.forEach((ln, i) => {
    const ws = byLine.get(ln)!;
    if (i > 0) {
      const prev = byLine.get(order[i - 1])!;
      const a = prev[prev.length - 1];
      const b = ws[0];
      const tail = TAIL.exec(a.text)?.[0] ?? '';
      const head = HEAD.exec(b.text)?.[0] ?? '';
      const tokens = !!head && tail.length >= 8 && !/[.,;:]$/.test(a.text);
      const wrapped = wrapping && atEdge[i - 1] && tokens && tail.length >= 12;
      if (!wrapped) {
        // not joined, but it may still be a wrapped token: its box can extend to the next word
        if (atEdge[i - 1] && tokens) cont.push({ at: text.length - 1, start: text.length + 1, end: text.length + 1 + head.length });
        push('\n', null, -1);
      }
    }
    ws.forEach((w, k) => {
      if (k > 0) push(' ', null, -1);
      const cb = charBoxes(w);
      [...w.text].forEach((ch, j) => push(ch, cb[j], ln));
    });
  });
  repairQuotes(text);
  // regions (QR codes…) as extra lines whose characters all map to the region's box
  let ln = (order[order.length - 1] ?? -1) + 1;
  for (const g of regions) {
    if (text.length) push('\n', null, -1);
    push(`${g.label}: ${g.text.replace(/\s+/g, ' ')}`, g.box, ln++);
  }
  return { text: text.join(''), boxes, lines, cont };
}

/** Where a region's content starts and ends in the text built by ocrText. */
export function regionSpans(t: OcrText, regions: Region[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let from = t.text.length;
  for (let i = regions.length - 1; i >= 0; i--) {
    const line = `${regions[i].label}: ${regions[i].text.replace(/\s+/g, ' ')}`;
    const at = t.text.lastIndexOf(line, from);
    if (at < 0) continue;
    out.unshift({ start: at + regions[i].label.length + 2, end: at + line.length });
    from = at - 1;
  }
  return out;
}

export interface Fix {
  /** span in the OCR text as read */
  start: number;
  end: number;
  /** what the image really shows */
  text: string;
}

/** Apply corrections; a replaced span's characters share its boxes proportionally. */
export function applyFixes(t: OcrText, fixes: Fix[]): OcrText {
  const sorted = [...fixes].sort((a, b) => a.start - b.start);
  const text: string[] = [];
  const boxes: (Box | null)[] = [];
  const lines: number[] = [];
  const at: number[] = new Array(t.text.length + 1);
  let pos = 0;
  for (const f of sorted) {
    if (f.start < pos || f.end > t.text.length) continue;
    for (let i = pos; i < f.start; i++) {
      at[i] = text.length;
      text.push(t.text[i]);
      boxes.push(t.boxes[i]);
      lines.push(t.lines[i]);
    }
    for (let i = f.start; i < f.end; i++) at[i] = text.length;
    const src = [...Array(f.end - f.start).keys()].map((k) => f.start + k).filter((i) => t.boxes[i]);
    for (let k = 0; k < f.text.length; k++) {
      const i = src.length ? src[Math.min(src.length - 1, Math.floor((k * src.length) / f.text.length))] : -1;
      text.push(f.text[k]);
      boxes.push(i >= 0 ? t.boxes[i] : null);
      lines.push(i >= 0 ? t.lines[i] : -1);
    }
    pos = f.end;
  }
  for (let i = pos; i < t.text.length; i++) {
    at[i] = text.length;
    text.push(t.text[i]);
    boxes.push(t.boxes[i]);
    lines.push(t.lines[i]);
  }
  at[t.text.length] = text.length;
  const cont = t.cont?.map((c) => ({ at: at[c.at], start: at[c.start], end: at[c.end - 1] + 1 }));
  return { text: text.join(''), boxes, lines, cont };
}

/**
 * One rectangle per visual line covered by the span, padded by `pad` × line height (at least 2 px)
 * and rounded outward to whole pixels, clipped to the image.
 */
export function spanBoxes(t: OcrText, start: number, end: number, pad: number, w: number, h: number): Box[] {
  const per = new Map<number, Box>();
  for (let i = start; i < end && i < t.boxes.length; i++) {
    const b = t.boxes[i];
    if (!b) continue;
    const cur = per.get(t.lines[i]);
    per.set(t.lines[i], cur ? [Math.min(cur[0], b[0]), Math.min(cur[1], b[1]), Math.max(cur[2], b[2]), Math.max(cur[3], b[3])] : [...b]);
  }
  // as tall as the whole text line: "anna" has no ascenders, its neighbours do
  const ext = lineExtents(t);
  return [...per.entries()].map(([ln, b]) => {
    const e = ext.get(ln);
    return padBox(e ? [b[0], Math.min(b[1], e[0]), b[2], Math.max(b[3], e[1])] : b, pad, w, h);
  });
}

const extents = new WeakMap<OcrText, Map<number, [number, number]>>();
/** top and bottom of every visual line */
function lineExtents(t: OcrText): Map<number, [number, number]> {
  let m = extents.get(t);
  if (m) return m;
  m = new Map();
  for (let i = 0; i < t.boxes.length; i++) {
    const b = t.boxes[i];
    if (!b) continue;
    const cur = m.get(t.lines[i]);
    m.set(t.lines[i], cur ? [Math.min(cur[0], b[1]), Math.max(cur[1], b[3])] : [b[1], b[3]]);
  }
  extents.set(t, m);
  return m;
}

export function padBox(b: Box, pad: number, w: number, h: number): Box {
  const p = Math.max(2, (b[3] - b[1]) * pad);
  return [Math.max(0, Math.floor(b[0] - p)), Math.max(0, Math.floor(b[1] - p)), Math.min(w, Math.ceil(b[2] + p)), Math.min(h, Math.ceil(b[3] + p))];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** Edit distance between a and b, giving up above `max` (returns max + 1). */
function within(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Spans of `t` that read as `value` (ignoring case and spaces; one wrong character allowed for
 * values of 8+ characters). Used to check that a redacted image no longer shows a masked value.
 */
export function findValue(t: OcrText, value: string): { start: number; end: number }[] {
  const v = norm(value);
  if (v.length < 4) return [];
  const idx: number[] = [];
  let flat = '';
  for (let i = 0; i < t.text.length; i++) {
    if (/\s/.test(t.text[i])) continue;
    flat += t.text[i].toLowerCase();
    idx.push(i);
  }
  const out: { start: number; end: number }[] = [];
  const max = v.length >= 8 ? 1 : 0;
  /** closest window starting at s: [distance, length] (distance max + 1 when none is close) */
  const best = (s: number): [number, number] => {
    // with at most one edit the window starts with v[0] or v[1], or its second character is v[1]
    if (s >= flat.length || (flat[s] !== v[0] && flat[s] !== v[1] && flat[s + 1] !== v[1])) return [max + 1, 0];
    let bd = max + 1;
    let bl = 0;
    for (let len = v.length - max; len <= v.length + max; len++) {
      if (s + len > flat.length) break;
      const w = flat.slice(s, s + len);
      const d = max ? within(w, v, max) : w === v ? 0 : 1;
      if (d < bd || (d === bd && Math.abs(len - v.length) < Math.abs(bl - v.length))) {
        bd = d;
        bl = len;
      }
    }
    return [bd, bl];
  };
  for (let s = 0; s < flat.length; s++) {
    let [d, len] = best(s);
    if (d > max) continue;
    // a later start may match better ("s Kv7…" against "Kv7…")
    for (let k = 1; k <= max && d > 0; k++) {
      const [d2, l2] = best(s + k);
      if (d2 < d) {
        s += k;
        d = d2;
        len = l2;
      }
    }
    out.push({ start: idx[s], end: idx[s + len - 1] + 1 });
    s += len - 1;
  }
  return out;
}
