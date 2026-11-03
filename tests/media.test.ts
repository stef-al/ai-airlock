import { describe, expect, it } from 'vitest';
import { describeImage } from '../src/media/metadata';
import { applyFixes, findValue, ocrText, regionSpans, spanBoxes } from '../src/media/ocrdoc';
import type { Box, OcrResult, OcrWord } from '../src/media/ocrTypes';

/** Words laid out like a screenshot: 10 px per character, lines 20 px apart. */
function page(lines: string[], x0 = 10): OcrResult {
  const words: OcrWord[] = [];
  lines.forEach((line, ln) => {
    let x = x0;
    for (const w of line.split(' ')) {
      const y = 10 + ln * 20;
      const chars = [...w].map((c, i) => ({ text: c, conf: 90, box: [x + i * 10, y, x + i * 10 + 9, y + 14] as Box }));
      words.push({ text: w, conf: 90, box: [x, y, x + w.length * 10 - 1, y + 14], line: ln, chars });
      x += (w.length + 1) * 10;
    }
  });
  return { text: lines.join('\n'), conf: 90, words };
}

describe('OCR text with character boxes', () => {
  it('keeps one box per character and finds them for a span', () => {
    const t = ocrText(page(['user: ops@acme.io', 'password: Kv7-mQ2']));
    expect(t.text).toBe('user: ops@acme.io\npassword: Kv7-mQ2');
    const at = t.text.indexOf('Kv7');
    expect(t.boxes[at]).toEqual([110, 30, 119, 44]);
    expect(t.boxes[t.text.indexOf('\n')]).toBeNull();
    // padded by 20% of the line height, at least 2 px, rounded outward
    expect(spanBoxes(t, at, at + 7, 0.2, 1000, 1000)).toEqual([[107, 27, 182, 47]]);
    // a span over two lines gives one box per line
    expect(spanBoxes(t, t.text.indexOf('acme'), at + 3, 0, 1000, 1000)).toHaveLength(2);
  });

  it('joins a token wrapped at the column edge, and only there', () => {
    const long = 'ghp_aB3dE5fG7hJ9kL1';
    // wrapped text: several lines end at the same x (the column edge)
    const t = ocrText(page([`token ${long}`, 'mN3pQ5rS7tU9vW and moreXX', 'text that also wraps here', 'end']));
    expect(t.text.split('\n')[0]).toBe(`token ${long}mN3pQ5rS7tU9vW and moreXX`);
    // the longest line of a config file is not a wrapped one
    const env = ocrText(page(['SENDGRID_API_KEY=SG.abcdefghijklmnop', 'OPENAI_API_KEY=sk-1234567890', 'PORT=8080']));
    expect(env.text.split('\n')).toHaveLength(3);
    // a sentence that simply continues is not joined
    expect(ocrText(page(['please call me when you are back.', 'thanks for the quick reply ok', 'and see you soon in the office'])).text.split('\n')).toHaveLength(3);
  });

  it('adds regions (QR codes) as text covered by their box', () => {
    const regions = [{ label: 'QR code', text: 'otpauth://totp/acme?secret=JBSWY3DPEHPK3PXP', box: [500, 500, 600, 600] as Box }];
    const t = ocrText(page(['scan this', 'Il|1 rbd']), regions.map((g) => ({ ...g, box: [0, 25, 600, 600] as Box })));
    // words read inside the code are noise and dropped
    expect(t.text.startsWith('scan this\nQR code: ')).toBe(true);
    const t2 = ocrText(page(['scan this']), regions);
    const [span] = regionSpans(t2, regions);
    expect(t2.text.slice(span!.start, span!.end)).toBe(regions[0].text);
    expect(t2.boxes[span!.start + 3]).toEqual([500, 500, 600, 600]);
  });

  it('adds faces as regions that keep the words under them, and makes them findings', async () => {
    const { faceRegion } = await import('../src/media/ocrdoc');
    const { regionHits } = await import('../src/media/image');
    const face = faceRegion([0, 25, 600, 600], 0.83);
    const qr = { label: 'QR code', text: 'https://example.org/x', box: [700, 700, 800, 800] as Box };
    const t = ocrText(page(['scan this', 'Il|1 rbd']), [face, qr]);
    // a face box does not hide the text under it from detection (a wrong box must not hide a secret)
    expect(t.text).toBe('scan this\nIl|1 rbd\nFace: face at 0,25 (600×575 px)\nQR code: https://example.org/x');
    const hits = regionHits(t, [face, qr]);
    expect(hits.map((h) => [h.type, h.confidence, t.text.slice(h.start, h.end)])).toEqual([
      ['FACE', 0.83, 'face at 0,25 (600×575 px)'],
      ['QR', 1, 'https://example.org/x'],
    ]);
    expect(hits[0].reason).toMatch(/face found by the detector \(score 83%\)/);
  });

  it('repairs quotes OCR got wrong, without moving any box', () => {
    const t = ocrText(page(["ALTER LOGIN app WITH PASSWORD = 'Bl1ng!Ap9\";", "IDENTIFIED BY ''Rep0rt-ro#1';", "SET x = ‘bob’, it's fine"]));
    expect(t.text.split('\n')).toEqual(["ALTER LOGIN app WITH PASSWORD = 'Bl1ng!Ap9';", "IDENTIFIED BY  'Rep0rt-ro#1';", "SET x = 'bob', it's fine"]);
    expect(t.boxes.length).toBe(t.text.length);
    const g = ocrText(page(["login(\"admin®, \"Zx9!qwerty\")", "VALUES ('bob', *hunter22x', now())"]));
    expect(g.text.split('\n')).toEqual(["login(\"admin\", \"Zx9!qwerty\")", "VALUES ('bob', 'hunter22x', now())"]);
  });

  it('marks where a token at the right edge may continue on the next line', () => {
    const t = ocrText(page(['secret: aB3dE5fG7hJ9kL1mN3', 'pQ5rS7tU9 is the rest', 'ok']));
    expect(t.cont).toHaveLength(1);
    const c = t.cont![0];
    expect(t.text[c.at]).toBe('3');
    expect(t.text.slice(c.start, c.end)).toBe('pQ5rS7tU9');
  });

  it('applies corrections of misread characters, keeping their boxes', () => {
    const t = ocrText(page(['DB_PASSWORD=Hunter22x1Qz']));
    const s = t.text.indexOf('Hunter');
    const f = applyFixes(t, [{ start: s, end: s + 12, text: 'Hunter22x!Qz' }]);
    expect(f.text).toBe('DB_PASSWORD=Hunter22x!Qz');
    expect(f.boxes[s + 9]).toEqual(t.boxes[s + 9]);
    // a longer replacement spreads over the same boxes
    const g = applyFixes(t, [{ start: s, end: s + 6, text: 'Hunters' }]);
    expect(g.text).toBe('DB_PASSWORD=Hunters22x1Qz');
    expect(g.boxes[s + 6]).not.toBeNull();
  });

  it('finds a masked value again, ignoring case, spaces and one misread character', () => {
    const t = ocrText(page(['the code is Kv7mQ2 wZ9pL4 ok', 'again kv7mq2wz9pl5']));
    const spans = findValue(t, 'Kv7mQ2wZ9pL4');
    expect(spans.map((x) => t.text.slice(x.start, x.end))).toEqual(['Kv7mQ2 wZ9pL4', 'kv7mq2wz9pl5']);
    expect(findValue(t, 'abc')).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// metadata (files built byte by byte)

const bytes = (...parts: (number[] | string | Uint8Array)[]) => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : [...p]));
  return new Uint8Array(out);
};
const le16 = (n: number) => [n & 255, n >> 8];
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
const be16 = (n: number) => [n >> 8, n & 255];
const be32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];

/** little-endian TIFF with camera make "Canon" and an (empty) GPS IFD */
const tiff = bytes('II', le16(42), le32(8), le16(2), le16(0x010f), le16(2), le32(6), le32(38), le16(0x8825), le16(4), le32(1), le32(44), le32(0), 'Canon\0', le16(0), le32(0));

describe('image metadata', () => {
  it('reports EXIF GPS and camera in JPEG', () => {
    const app1 = bytes('Exif\0\0', tiff);
    const jpeg = bytes([0xff, 0xd8, 0xff, 0xe1], be16(app1.length + 2), app1, [0xff, 0xfe], be16(9), 'hello!!', [0xff, 0xda, 0, 2]);
    const m = describeImage(jpeg);
    expect(m.format).toBe('jpeg');
    expect(m.found).toEqual(['EXIF: camera make (Canon)', 'EXIF: GPS location', 'comment (hello!!)']);
  });

  it('reports PNG text chunks and APNG frames', () => {
    const chunk = (type: string, data: Uint8Array) => bytes(be32(data.length), type, data, [0, 0, 0, 0]);
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk('IHDR', new Uint8Array(13)), chunk('acTL', bytes(be32(3), be32(0))), chunk('tEXt', bytes('Author\0Jane')), chunk('IEND', new Uint8Array(0)));
    expect(describeImage(png)).toEqual({ format: 'png', found: ['PNG text: Author'], frames: 3 });
  });

  it('counts GIF frames and comments', () => {
    const img = bytes([0x2c], new Array(8).fill(0), [0x00, 0x02, 0x01, 0x05, 0x00]);
    const gif = bytes('GIF89a', le16(1), le16(1), [0, 0, 0], [0x21, 0xfe, 3], 'hi!', [0], img, img, [0x3b]);
    expect(describeImage(gif)).toEqual({ format: 'gif', found: ['GIF comment'], frames: 2 });
  });

  it('reads WebP EXIF and animation frames', () => {
    const ch = (type: string, data: Uint8Array) => bytes(type, le32(data.length), data, data.length & 1 ? [0] : []);
    const body = bytes('WEBP', ch('VP8X', new Uint8Array(10)), ch('EXIF', tiff), ch('ANMF', new Uint8Array(16)), ch('ANMF', new Uint8Array(16)));
    const webp = bytes('RIFF', le32(body.length), body);
    const m = describeImage(webp);
    expect(m.format).toBe('webp');
    expect(m.found).toContain('EXIF: GPS location');
    expect(m.frames).toBe(2);
  });
});
