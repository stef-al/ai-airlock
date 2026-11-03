import { describe, expect, it } from 'vitest';
import { spanBoxes } from '../src/media/ocrdoc';
import type { OcrWord } from '../src/media/ocrTypes';
import { joinPages, layerText, pageText, placeItem, type LayerItem } from '../src/media/pdftext';
import { writeImagePdf } from '../src/media/pdfwrite';

/** a text item at (x, baseline y) on an upright page, 10 pt, 5 pt per character */
const item = (str: string, x: number, y: number, eol = false, extra: Partial<LayerItem> = {}): LayerItem => ({ str, tx: [10, 0, 0, -10, x, y], width: str.length * 5, eol, ...extra });
const place = (...items: LayerItem[]) => items.map((i) => placeItem(i));
const word = (text: string, box: [number, number, number, number], line: number): OcrWord => ({ text, conf: 90, box, line, chars: [] });

describe('pdf: image-only writer', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const out = writeImagePdf([
    { jpeg, wPx: 1275, hPx: 1650, wPt: 612, hPt: 792 },
    { jpeg, wPx: 1650, hPx: 1275, wPt: 792, hPt: 612 },
  ]);
  const text = new TextDecoder('latin1').decode(out);

  it('writes one image per page and nothing else', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/MediaBox [0 0 612 792]');
    expect(text).toContain('/MediaBox [0 0 792 612]');
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect(text).toContain('/Width 1650 /Height 1275');
    for (const banned of ['/Font', 'BT', '/Info', '/Metadata', '/Annots', '/EmbeddedFile', '/JavaScript', '/AcroForm', '/Outlines']) expect(text).not.toContain(banned);
  });

  it('has a cross-reference table that points at every object', () => {
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const [, count] = /xref\n0 (\d+)\n/.exec(text.slice(xref))!;
    const entries = text.slice(xref).split('\n').slice(3, 2 + Number(count));
    expect(entries).toHaveLength(Number(count) - 1);
    entries.forEach((e, i) => {
      expect(e.length).toBe(19); // 20 bytes with the line feed
      expect(text.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + 8)).toBe(`${i + 1} 0 obj`.padEnd(8, '\n').slice(0, 8));
    });
    // the image stream is the JPEG, byte for byte
    const at = text.indexOf('stream\n', text.indexOf('/DCTDecode')) + 7;
    expect([...out.subarray(at, at + jpeg.length)]).toEqual([...jpeg]);
  });

  it('opens in pdf.js with the page sizes and no text', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: out.slice(), isEvalSupported: false, verbosity: 0 } as never);
    const doc = await task.promise;
    expect(doc.numPages).toBe(2);
    const p2 = await doc.getPage(2);
    expect(p2.getViewport({ scale: 1 }).width).toBe(792);
    expect((await p2.getTextContent()).items).toHaveLength(0);
    expect((await p2.getAnnotations()).length).toBe(0);
    expect((await doc.getMetadata()).metadata).toBeNull();
    await task.destroy();
  });
});

describe('pdf: text layer with character boxes', () => {
  it('places characters within an item and breaks lines at end of line or a baseline change', () => {
    const t = layerText(place(item('user:', 72, 100), item('alice', 102, 100, true), item('Password Kv7', 72, 114), item('end', 72, 140)));
    expect(t.text).toBe('user: alice\nPassword Kv7\nend');
    // 'a' of alice: 5 pt wide from x = 102, ascent 0.8 and descent 0.2 of 10 pt
    expect(t.boxes[6]).toEqual([102, 92, 107, 102]);
    expect(t.boxes[5]).toBeNull(); // the joining space
    expect(t.lines[6]).toBe(0);
    expect(t.lines[12]).toBe(1);
  });

  it('turns a value into one box per visual line', () => {
    const t = layerText(place(item('token Kv7mQ2', 72, 100)));
    expect(spanBoxes(t, 6, 12, 0.2, 612, 792)).toEqual([[100, 90, 134, 104]]);
  });

  it('places text on rotated pages', () => {
    // a page rotated by 90°: text runs downwards
    const t = layerText([placeItem({ str: 'abc', tx: [0, 10, 10, 0, 50, 100], width: 15, eol: false })]);
    expect(t.boxes[0]).toEqual([48, 100, 58, 105]);
    expect(t.boxes[2]).toEqual([48, 110, 58, 115]);
  });

  it('shares an item width by measured character widths', () => {
    const p = placeItem({ str: 'iW', tx: [10, 0, 0, -10, 0, 50], width: 12, eol: false }, (ch) => (ch === 'W' ? 3 : 1));
    expect(p.chars.map((b) => b[2] - b[0])).toEqual([3, 9]);
  });

  it('keeps the indentation of monospace text', () => {
    const mono = { family: 'monospace' };
    const t = layerText(place(item('db:', 72, 100, true, mono), item('password: x', 92, 112, true, mono)));
    expect(t.text).toBe('db:\n    password: x');
  });

  it('marks tokens that may continue on the next line', () => {
    // three lines end at the same right edge (x = 137): the text wraps there; the token line ends
    // 8 pt short of it, too far to be a break inside the token, close enough to be covered with it
    const t = layerText(place(item('aaaa bbb cccc', 72, 100, true), item('cccc ddd eeee', 72, 112, true), item('key q7Zx9Lm2', 72, 124, true, { width: 57 }), item('Vb8Tr4 rest', 72, 136)));
    expect(t.text).toBe('aaaa bbb cccc\ncccc ddd eeee\nkey q7Zx9Lm2\nVb8Tr4 rest');
    expect(t.cont).toEqual([{ at: t.text.indexOf('Lm2') + 2, start: t.text.indexOf('Vb8'), end: t.text.indexOf('Vb8') + 6 }]);
  });

  it('joins lines broken in the middle of a token, not word-wrapped prose', () => {
    const full = { width: 68 }; // every line ends at the column edge (x = 140), as in justified text
    const prose = ['the quick brown', 'fox jumps over', 'the lazy dog and', 'then from 10.', '0.0.5 it went', 'home with the', 'other dogs in 2024'];
    const t = layerText(place(...prose.map((l, i) => item(l, 72, 100 + 12 * i, true, full)), item('we went', 72, 184)));
    expect(t.text).toBe('the quick brown\nfox jumps over\nthe lazy dog and\nthen from 10.0.0.5 it went\nhome with the\nother dogs in 2024\nwe went');
    // an email or an assignment broken between two letters
    const mail = layerText(place(item('mail maria.lopez@globex-c', 72, 100, true, full), item('orp.net now; Passwor', 72, 112, true, full), item('d=Sa!Str0ng99; ok.', 72, 124, true, full), item('Done', 72, 136)));
    expect(mail.text).toBe('mail maria.lopez@globex-corp.net now; Password=Sa!Str0ng99; ok.\nDone');
    // a long token split in two is joined without a column edge too
    expect(layerText(place(item('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6', 72, 100, true), item('MDAwMDI0NX0.N-o5RH', 72, 112))).text).toBe('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6MDAwMDI0NX0.N-o5RH');
    // once breaks inside tokens show the text breaks anywhere, letters are joined too (a printed CSV row)
    const rows = [item('Acme,Hans,Welc0m', 72, 100, true, full), item('e-2024,Key ac', 72, 112, true, full), item('count,x', 72, 124, true), item('Globex,Ana,S3cur3', 72, 136, true, full), item('!Pass,ok', 72, 148)];
    expect(layerText(place(...rows)).text).toBe('Acme,Hans,Welc0me-2024,Key account,x\nGlobex,Ana,S3cur3!Pass,ok');
    // joined characters keep their own lines' boxes
    const ip = t.text.indexOf('10.0.0.5');
    expect(spanBoxes(t, ip, ip + 8, 0, 612, 792)).toHaveLength(2);
  });
});

describe('pdf: page text', () => {
  it('adds OCR words the text layer does not have, and annotation and QR lines', () => {
    const items = place(item('Report', 72, 100, true));
    const ocr = [word('Report', [72, 92, 102, 102], 0), word('secret=Kv7mQ2', [100, 300, 200, 312], 1)];
    const t = pageText({
      items,
      ocr,
      annots: [{ label: 'Form field "IBAN"', text: 'DE89 3704', box: [300, 500, 400, 520] }, { label: 'Link', text: 'https://wiki.corp.local/x', box: null }],
      qr: [{ text: 'otpauth://totp/x', box: [10, 10, 60, 60] }],
      width: 612,
    });
    expect(t.text.text).toBe('Report\nsecret=Kv7mQ2\nQR code: otpauth://totp/x\nForm field "IBAN": DE89 3704\nLink: https://wiki.corp.local/x');
    expect(t.ocrWords).toBe(1);
    expect(t.text.text.slice(t.qr[0].start, t.qr[0].end)).toBe('otpauth://totp/x');
    const iban = t.text.text.indexOf('DE89');
    expect(spanBoxes(t.text, iban, iban + 9, 0, 612, 792)).toEqual([[298, 498, 402, 522]]);
    const link = t.text.text.indexOf('wiki');
    expect(spanBoxes(t.text, link, link + 4, 0, 612, 792)).toEqual([]);
  });

  it('joins pages with a marker line before each page', () => {
    const { text, offsets } = joinPages(['first page', 'second']);
    expect(text).toBe('=== Page 1 ===\nfirst page\n\n=== Page 2 ===\nsecond');
    expect(text.slice(offsets[1], offsets[1] + 6)).toBe('second');
    expect(joinPages(['only']).text).toBe('only');
  });
});
