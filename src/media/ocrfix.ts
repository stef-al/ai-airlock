// Repairs of OCR word splits that the pixels can settle (pure: runs in Node).
// - An underscore sits under the baseline; Tesseract often drops it and leaves a word gap
//   (DATABASE_URL → DATABASE URL, sk_live_… → sk live …). A gap with ink under the baseline
//   across its width and none above is an underscore. The baseline is taken from the characters
//   next to the gap (lines in photos are tilted), and the ink must be below it: serif feet sit on
//   it and reach into narrow gaps.
// - In monospace text a narrow glyph (- . : ! ,) leaves white on both sides of its cell, so OCR
//   splits words around it (El3ment-Pw → El3ment - Pw). A gap much narrower than the character
//   pitch is no space. Only when most lines are monospace: digits are as wide as each other in
//   most fonts, so a row of numbers alone looks monospace.
// - Monospace lines keep their indentation (YAML, Python): counted in character cells.
import type { OcrChar, OcrResult, OcrWord } from './ocrTypes';

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * character pitch of a line when its characters sit on a regular grid (monospace), else 0; pairs
 * of digits do not count (most fonts give digits one width)
 */
export function linePitch(words: OcrWord[]): number {
  const deltas: number[] = [];
  for (const w of words)
    for (let i = 1; i < w.chars.length; i++) {
      if (!/\p{L}/u.test(w.chars[i].text + w.chars[i - 1].text)) continue;
      deltas.push((w.chars[i].box[0] + w.chars[i].box[2]) / 2 - (w.chars[i - 1].box[0] + w.chars[i - 1].box[2]) / 2);
    }
  if (deltas.length < 6) return 0;
  const m = median(deltas);
  if (m <= 0) return 0;
  return deltas.filter((d) => Math.abs(d - m) <= 0.15 * m).length >= 0.8 * deltas.length ? m : 0;
}

const lum = (p: Pixels, x: number, y: number) => {
  const i = (y * p.width + x) * 4;
  return 0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2];
};

/**
 * share of the columns x0..x1 with ink somewhere in rows y0..y1 (an underscore is a thin,
 * anti-aliased line: a fifth of the way to black counts)
 */
function inkColumns(p: Pixels, x0: number, x1: number, y0: number, y1: number, bg: number, min = 40): number {
  const xa = Math.max(0, Math.ceil(x0));
  const xb = Math.min(p.width - 1, Math.floor(x1));
  const ya = Math.max(0, Math.round(y0));
  const yb = Math.min(p.height - 1, Math.round(y1));
  if (xb < xa || yb < ya) return 0;
  let n = 0;
  for (let x = xa; x <= xb; x++) {
    for (let y = ya; y <= yb; y++) {
      if (Math.abs(lum(p, x, y) - bg) > min) {
        n++;
        break;
      }
    }
  }
  return n / (xb - xa + 1);
}

/**
 * Could the two words be one identifier with an underscore between them? Not after punctuation
 * (REDIS_URL: redis://), not two capitalised words (a name), not before a date, path or URL.
 */
const snake = (a: string, b: string) =>
  !/[:;,.!?)\]}>"'`]$/.test(a) && !/^[([{<"'`]/.test(b) && !(/^\p{Lu}\p{Ll}+$/u.test(a) && /^\p{Lu}\p{Ll}+(?![\p{L}\p{N}_])/u.test(b)) && !/^(?:\d{1,4}[/.:-]\d|[a-z][\w+.-]{0,20}:\/\/)/i.test(b);

function join(a: OcrWord, b: OcrWord, mid: OcrChar | null): OcrWord {
  return {
    text: a.text + (mid ? mid.text : '') + b.text,
    conf: Math.min(a.conf, b.conf),
    box: [Math.min(a.box[0], b.box[0]), Math.min(a.box[1], b.box[1]), Math.max(a.box[2], b.box[2]), Math.max(a.box[3], b.box[3])],
    line: a.line,
    chars: [...a.chars, ...(mid ? [mid] : []), ...b.chars],
  };
}

/**
 * Words of one line, merged where the gap between two of them is an underscore or, in monospace
 * text of the given pitch, no space at all. Boxes are in the pixels' coordinates; `floor` is the
 * top of the next line (tightly set code has its capitals just under this line's underscores).
 */
export function repairLine(words: OcrWord[], p: Pixels, pitch = linePitch(words), floor = Infinity): OcrWord[] {
  if (words.length < 2) return words;
  const top = median(words.map((w) => w.box[1]));
  // the baseline: where most characters end (descenders are the exception)
  const base = median(words.flatMap((w) => (w.chars.length ? w.chars.map((c) => c.box[3]) : [w.box[3]])));
  const h = base - top;
  if (!(h > 4)) return words;
  // background: the most common luminance along the line's left and right ends
  const bg = median([lum(p, Math.max(0, Math.round(words[0].box[0] - 2)), Math.round(top)), lum(p, Math.min(p.width - 1, Math.round(words[words.length - 1].box[2] + 2)), Math.round(top)), lum(p, Math.max(0, Math.round(words[0].box[0] - 2)), Math.round(base))]);
  const out: OcrWord[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const a = out[out.length - 1];
    const b = words[i];
    const gap = b.box[0] - a.box[2];
    if (gap > 0 && gap <= 1.6 * h && snake(a.text, b.text)) {
      // the baseline at the gap: the bottoms of the characters around it (descenders are outliers)
      const near = [...a.chars.slice(-3), ...b.chars.slice(0, 3)].map((c) => c.box[3]);
      const lb = near.length ? median(near) : base;
      // ink under the baseline across the gap, nothing in the body of the line: an underscore
      const low = Math.min(lb + 0.3 * h, floor - 1.5);
      const under = inkColumns(p, a.box[2] + 1, b.box[0] - 1, lb + 0.1 * h, low, bg);
      const body = inkColumns(p, a.box[2] + 1, b.box[0] - 1, lb - 0.7 * h, lb - 0.3 * h, bg);
      // an underline (a link) also runs under the letters next to the gap; an underscore stays in its cell
      const la = a.chars[a.chars.length - 1]?.box ?? a.box;
      const fb = b.chars[0]?.box ?? b.box;
      const underline = inkColumns(p, la[0], la[2], lb + 0.1 * h, low, bg) >= 0.8 && inkColumns(p, fb[0], fb[2], lb + 0.1 * h, low, bg) >= 0.8;
      if (under >= 0.7 && body <= 0.1 && !underline) {
        // OCR sometimes reads the underscore but puts a space before it (NODE _ENV)
        const has = a.text.endsWith('_') || b.text.startsWith('_');
        out[out.length - 1] = join(a, b, has ? null : { text: '_', conf: 50, box: [a.box[2], base - 0.1 * h, b.box[0], base + 0.3 * h] });
        continue;
      }
    }
    // monospace: a gap well under one character cell is no space
    if (pitch > 0 && gap < 0.45 * pitch) {
      out[out.length - 1] = join(a, b, null);
      continue;
    }
    out.push(b);
  }
  return out;
}

/** character pitch of the text when most lines are monospace (at least 2 and 60%), else 0 */
function textPitch(lines: OcrWord[][]): number {
  const pitches = lines.map(linePitch).filter((x) => x > 0);
  return pitches.length >= 2 && pitches.length >= 0.6 * lines.length ? median(pitches) : 0;
}

/** indentation of each line in character cells (monospace text) */
function indents(lines: OcrWord[][], pitch: number): number[] {
  if (!pitch) return lines.map(() => 0);
  const left = Math.min(...lines.map((l) => l[0].box[0]));
  return lines.map((l) => Math.max(0, Math.min(40, Math.round((l[0].box[0] - left) / pitch))));
}

/** All repairs over an OCR result (lines in reading order). */
export function repairOcr(r: OcrResult, p: Pixels): OcrResult {
  const byLine = new Map<number, OcrWord[]>();
  for (const w of r.words) (byLine.get(w.line) ?? byLine.set(w.line, []).get(w.line)!).push(w);
  const raw = [...byLine.keys()].sort((a, b) => a - b).map((k) => byLine.get(k)!);
  const pitch = textPitch(raw);
  // the top of the next line under each line (its words that start below this line's middle)
  const lines = raw.map((l, i) => {
    const mid = median(l.map((w) => (w.box[1] + w.box[3]) / 2));
    const below = raw.slice(i + 1, i + 3).flat().filter((w) => w.box[1] > mid);
    return repairLine(l, p, pitch, below.length ? median(below.map((w) => w.box[1])) : Infinity);
  });
  const ind = indents(lines, pitch);
  const words = lines.flatMap((l, i) => l.map((w, k) => (k === 0 && ind[i] ? { ...w, indent: ind[i] } : w)));
  return { ...r, words };
}
