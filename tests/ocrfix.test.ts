import { describe, expect, it } from 'vitest';
import { ocrText } from '../src/media/ocrdoc';
import { linePitch, repairLine, repairOcr, type Pixels } from '../src/media/ocrfix';
import type { Box, OcrWord } from '../src/media/ocrTypes';

/** a white image with black rectangles */
function pixels(w: number, h: number, ink: Box[]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [x0, y0, x1, y1] of ink) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  return { data, width: w, height: h };
}

/** a word of monospace characters, `pitch` px each, glyph box 1 px inside its cell; baseline at y = 30 */
function word(text: string, x: number, line = 0, pitch = 10, top = 10): OcrWord {
  const chars = [...text].map((c, i) => ({ text: c, conf: 90, box: [x + i * pitch + 1, top, x + (i + 1) * pitch - 1, top + 20] as Box }));
  return { text, conf: 90, box: [chars[0].box[0], top, chars[chars.length - 1].box[2], top + 20], line, chars };
}

describe('OCR repairs from the pixels', () => {
  it('finds the character pitch of monospace lines only', () => {
    expect(linePitch([word('DATABASE', 10), word('URL', 100)])).toBe(10);
    const proportional = word('Wilmington', 10);
    proportional.chars = proportional.chars.map((c, i) => ({ ...c, box: [10 + i * i * 3, 10, 12 + i * i * 3, 30] as Box }));
    expect(linePitch([proportional])).toBe(0);
  });

  it('puts back an underscore OCR dropped (ink under the baseline across the gap)', () => {
    const a = word('DATABASE', 10);
    const b = word('URL', 100);
    const p = pixels(200, 50, [[90, 32, 101, 35]]);
    const out = repairLine([a, b], p);
    expect(out.map((w) => w.text)).toEqual(['DATABASE_URL']);
    expect(out[0].chars).toHaveLength(12);
    // a faint, anti-aliased line counts; an underscore OCR already read is not doubled
    expect(repairLine([a, b], { ...p, data: p.data.map((v, i) => (i % 4 < 3 && v === 0 ? 190 : v)) }).map((w) => w.text)).toEqual(['DATABASE_URL']);
    expect(repairLine([a, word('_URL', 100)], p).map((w) => w.text)).toEqual(['DATABASE_URL']);
    // underlined words (a link): the line runs under the letters too, so it is no underscore
    expect(repairLine([a, b], pixels(200, 50, [[11, 32, 129, 35]])).map((w) => w.text)).toEqual(['DATABASE', 'URL']);
    // ink under a gap after punctuation, between two capitalised words or before a date is no underscore either (JPEG noise)
    const under = pixels(200, 50, [[90, 32, 101, 35]]);
    expect(repairLine([word('REDIS_URL:', 0), word('redis', 112)], pixels(200, 50, [[100, 32, 113, 35]])).map((w) => w.text)).toEqual(['REDIS_URL:', 'redis']);
    expect(repairLine([word('Anabel', 30), word('Ruiz', 100)], under).map((w) => w.text)).toEqual(['Anabel', 'Ruiz']);
    expect(repairLine([word('Anabel', 30), word('Ruiz,ana.ruiz@x', 100)], under).map((w) => w.text)).toEqual(['Anabel', 'Ruiz,ana.ruiz@x']);
    expect(repairLine([word('expires', 20), word('08/26', 100)], under).map((w) => w.text)).toEqual(['expires', '08/26']);
    // the tops of the next line, set tightly under this one, are no underscore
    const next = repairOcr({ text: '', conf: 90, words: [word('and', 10, 0, 10, 10), word('an', 60, 0, 10, 10), word('Refund', 10, 1, 10, 34)] }, pixels(200, 80, [[38, 34, 64, 37]]));
    expect(next.words.map((w) => w.text)).toEqual(['and', 'an', 'Refund']);
    // serif feet on the baseline reaching into a narrow gap are no underscore
    expect(repairLine([word('Hans', 10), word('Becker', 54)], pixels(200, 50, [[48, 28, 50, 30], [50, 29, 56, 30]])).map((w) => w.text)).toEqual(['Hans', 'Becker']);
    // a tilted line: the baseline next to the gap counts, not the line's
    const tilted = [word('DATABASE', 10, 0, 10, 10), word('URL', 100, 0, 10, 16)];
    expect(repairLine(tilted, pixels(200, 60, [[90, 38, 101, 41]])).map((w) => w.text)).toEqual(['DATABASE_URL']);
    // a gap with nothing in it stays a space
    expect(repairLine([a, b], pixels(200, 50, [])).map((w) => w.text)).toEqual(['DATABASE', 'URL']);
    // ink in the body of the line (another glyph) is no underscore
    expect(repairLine([a, b], pixels(200, 50, [[90, 32, 101, 35], [93, 15, 97, 25]])).map((w) => w.text)).toEqual(['DATABASE', 'URL']);
  });

  it('joins words split around a narrow glyph in monospace text, not real spaces', () => {
    // El3ment-Pw read as "El3ment" "-" "Pw": gaps of 3 px with a 10 px pitch
    const out = repairLine([word('El3ment', 10), word('-', 82), word('Pw', 88)], pixels(200, 50, []));
    expect(out.map((w) => w.text)).toEqual(['El3ment-Pw']);
    // "a - b" with real spaces (a whole cell each side) stays as it is
    expect(repairLine([word('total', 10), word('-', 70), word('count', 90)], pixels(200, 50, [])).map((w) => w.text)).toEqual(['total', '-', 'count']);
  });

  it('joins narrow gaps only when most lines are monospace', () => {
    // a row of numbers (digits share one width) among lines of proportional text
    const prose = (text: string, line: number) => {
      const w = word(text, 10, line, 10, 10 + 30 * line);
      w.chars = w.chars.map((c, i) => ({ ...c, box: [10 + i * i * 3, c.box[1], 12 + i * i * 3, c.box[3]] as Box }));
      return w;
    };
    const nums = [word('1200', 10, 2, 10, 70), word('1350', 52, 2, 10, 70), word('1400', 94, 2, 10, 70)];
    const r = repairOcr({ text: '', conf: 90, words: [prose('Quarterly', 0), prose('Revenue', 1), ...nums] }, pixels(300, 120, []));
    expect(r.words.map((w) => w.text)).toEqual(['Quarterly', 'Revenue', '1200', '1350', '1400']);
    // the same row in a monospace listing is joined where the gap is under half a cell
    const mono = repairOcr({ text: '', conf: 90, words: [word('Quarterly', 10, 0, 10, 10), word('Revenue', 10, 1, 10, 40), ...nums] }, pixels(300, 120, []));
    expect(mono.words.map((w) => w.text)).toEqual(['Quarterly', 'Revenue', '120013501400']);
  });

  it('keeps the indentation of monospace lines', () => {
    const r = repairOcr({ text: '', conf: 90, words: [word('server:', 10, 0, 10, 10), word('password:', 50, 1, 10, 40), word('x', 150, 1, 10, 40)] }, pixels(300, 80, []));
    expect(ocrText(r).text).toBe('server:\n    password: x');
  });
});
