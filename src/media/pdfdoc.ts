// PDF documents: text layer + OCR + annotations per page → one text for the usual detection and
// masking (engine worker) → every page re-rendered with opaque boxes → OCR of the copy to check
// nothing is left → an image-only PDF without text layer, metadata, annotations or attachments.
import type { Hit, Settings } from '../engine/light';
import { CancelledError } from '../ui/engineClient';
import type { MaskRes } from '../worker/protocol';
import type { ManualBox, VerifyReport } from './image';
import { readPixels } from './mediaClient';
import { findValue, ocrText, spanBoxes, type OcrText } from './ocrdoc';
import type { Box, OcrWord } from './ocrTypes';
import { imageOptions, ocrLangs, pdfOptions, pdfReadKey } from './options';
import { paintBoxes } from './paint';
import { canvasMeasure, inventory, openPdf, readPage, renderPage, type OpenPdf, type PdfInventory } from './pdf';
import { joinPages, pageText, placeItem } from './pdftext';
import { writeImagePdf } from './pdfwrite';
import type { RenderBox } from './protocol';

export { PdfPasswordError } from './pdf';
export { pdfOptions, pdfReadKey } from './options';

export interface PdfPage {
  /** size in points, rotation applied: the unit of every box of the page */
  w: number;
  h: number;
  text: OcrText;
  /** QR code contents (page-local offsets) */
  qr: { start: number; end: number }[];
  /** faces found on the page (page-local offsets of their lines, detector scores) */
  faces: { start: number; end: number; score: number }[];
  /** OCR ran on the page; words = how many it added to the text layer */
  ocr: { ms: number; conf: number; words: number } | null;
  images: boolean;
  /** lowest native resolution of the page's larger images (0 if none) */
  imageDpi: number;
  dropped: { links: number; comments: number; attachments: number };
}

export interface PdfManualBox extends ManualBox {
  page: number;
}

export interface PdfPageOut {
  jpeg: Uint8Array;
  wPx: number;
  hPx: number;
  /** boxes painted, in page units */
  boxes: RenderBox[];
  verify: VerifyReport;
}

export interface PdfOutput {
  bytes: Uint8Array;
  key: string;
  pages: PdfPageOut[];
  verify: VerifyReport;
  ms: number;
}

export interface PdfState {
  bytes: Uint8Array;
  /** kept in memory only, to open the file again */
  password?: string;
  locked?: 'need' | 'wrong';
  inv?: PdfInventory;
  pages: PdfPage[];
  /** where each page starts in the document text */
  offsets: number[];
  /** some page's text came from OCR (detection then tolerates misreads) */
  usedOcr: boolean;
  readKey?: string;
  readMs?: number;
  manual: PdfManualBox[];
  rver: number;
  out?: PdfOutput;
  rendering?: boolean;
  progress?: string;
  reviewed: boolean;
}

export const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

export function newPdfState(bytes: Uint8Array): PdfState {
  return { bytes, pages: [], offsets: [], usedOcr: false, manual: [], rver: 0, reviewed: false };
}

// open documents, by file (closed when the document is removed or everything is forgotten)
const open = new Map<Uint8Array, { password?: string; p: Promise<OpenPdf> }>();

function docOf(st: PdfState): Promise<OpenPdf> {
  const cur = open.get(st.bytes);
  if (cur && cur.password === st.password) return cur.p;
  if (cur) void cur.p.then((o) => o.close()).catch(() => {});
  const p = openPdf(st.bytes, st.password);
  open.set(st.bytes, { password: st.password, p });
  p.catch(() => open.delete(st.bytes));
  return p;
}

export async function closePdf(bytes: Uint8Array): Promise<void> {
  const cur = open.get(bytes);
  open.delete(bytes);
  if (cur) await cur.p.then((o) => o.close()).catch(() => {});
}

export async function closeAllPdfs(): Promise<void> {
  await Promise.all([...open.keys()].map(closePdf));
}

// bumped by cancelPdf(): running reads and redactions stop at the next page
let gen = 0;
export function cancelPdf(): void {
  gen++;
}
const stopper = () => {
  const g = gen;
  return () => {
    if (g !== gen) throw new CancelledError('Stopped.');
  };
};

const scaleBox = (b: Box, k: number): Box => [b[0] * k, b[1] * k, b[2] * k, b[3] * k];
/**
 * Pixels per point for OCR: 200 DPI, or twice the native resolution of low-resolution images
 * (a screenshot placed in a document) up to 300 DPI, as screenshots are enlarged; at most 3600 px.
 */
const ocrScale = (w: number, h: number, imageDpi: number) => Math.min((imageDpi > 0 && imageDpi < 150 ? Math.min(300, Math.max(200, 2 * imageDpi)) : 200) / 72, 3600 / Math.max(w, h));
const QR_SCALE = 150 / 72;

const canvasBitmap = (c: HTMLCanvasElement) => () => createImageBitmap(c);
const release = (c: HTMLCanvasElement) => {
  c.width = 0;
  c.height = 0;
};

export interface PdfRead {
  inv: PdfInventory;
  pages: PdfPage[];
  offsets: number[];
  usedOcr: boolean;
  text: string;
  /** QR codes: always masked, like in images */
  extra: Hit[];
  readKey: string;
  readMs: number;
}

/**
 * Every page: text layer and annotations; OCR when the page shows images or has (almost) no text
 * layer (or always, by setting); QR codes. One text for the whole document.
 */
export async function readPdf(st: PdfState, s: Settings, progress: (msg: string) => void = () => {}): Promise<PdfRead> {
  const t0 = performance.now();
  const check = stopper();
  const { doc } = await docOf(st);
  const inv = await inventory(doc, st.bytes);
  const o = pdfOptions(s);
  const io = imageOptions(s);
  const langs = ocrLangs(s);
  const n = Math.min(doc.numPages, o.maxPages);
  const measure = canvasMeasure();
  const pages: PdfPage[] = [];
  for (let i = 1; i <= n; i++) {
    check();
    progress(`Reading page ${i} of ${n}…`);
    const page = await doc.getPage(i);
    const r = await readPage(page);
    const placed = r.items.map((it) => placeItem(it, measure));
    const chars = r.items.reduce((k, it) => k + it.str.replace(/\s/g, '').length, 0);
    const wantOcr = o.ocr === 'always' || r.images || chars < 40;
    let words: OcrWord[] = [];
    let qr: { text: string; box: Box }[] = [];
    let faces: { box: Box; score: number }[] = [];
    let ocr: PdfPage['ocr'] = null;
    if (wantOcr || io.qr) {
      if (wantOcr) progress(`Reading page ${i} of ${n} (OCR)…`);
      const k = wantOcr ? ocrScale(r.w, r.h, r.imageDpi) : Math.min(QR_SCALE, 3000 / Math.max(r.w, r.h));
      const canvas = await renderPage(page, k);
      try {
        // faces where there are pictures: the pages that get OCR
        const res = await readPixels(canvasBitmap(canvas), langs, { qr: io.qr, ocr: wantOcr, upscale: false, faces: wantOcr && io.faces });
        words = res.ocr.words.map((w) => ({ ...w, box: scaleBox(w.box, 1 / k), chars: w.chars.map((c) => ({ ...c, box: scaleBox(c.box, 1 / k) })) }));
        qr = res.qr.map((q) => ({ text: q.text, box: scaleBox(q.box, 1 / k) }));
        faces = res.faces.map((f) => ({ box: scaleBox(f.box, 1 / k), score: f.score }));
        if (wantOcr) ocr = { ms: res.ms, conf: res.ocr.conf, words: 0 };
      } finally {
        release(canvas);
      }
    }
    page.cleanup();
    const t = pageText({ items: placed, ocr: words, annots: r.annots, qr, faces, width: r.w });
    if (ocr) ocr.words = t.ocrWords;
    pages.push({ w: r.w, h: r.h, text: t.text, qr: t.qr, faces: t.faces, ocr, images: r.images, imageDpi: r.imageDpi, dropped: r.dropped });
  }
  const { text, offsets } = joinPages(pages.map((p) => p.text.text));
  const extra: Hit[] = pages.flatMap((p, i) => [
    ...p.qr.map((sp) => ({ start: sp.start + offsets[i], end: sp.end + offsets[i], type: 'QR', category: 'custom' as const, detector: 'media.qr', confidence: 1, reason: 'QR code: always masked, whatever it contains', priority: 5, user: 'region' as const })),
    ...p.faces.map((sp) => ({ start: sp.start + offsets[i], end: sp.end + offsets[i], type: 'FACE', category: 'personal' as const, detector: 'media.face', confidence: Math.round(sp.score * 100) / 100, reason: `face found by the detector (score ${Math.round(sp.score * 100)}%)`, priority: 5, user: 'region' as const })),
  ]);
  return { inv, pages, offsets, usedOcr: pages.some((p) => (p.ocr?.words ?? 0) > 0), text, extra, readKey: pdfReadKey(s), readMs: Math.round(performance.now() - t0) };
}

/** Page-local span of a document span (clipped to the page). */
function local(st: PdfState, i: number, start: number, end: number): [number, number] | null {
  const off = st.offsets[i];
  const len = st.pages[i].text.text.length;
  const s = Math.max(start, off) - off;
  const e = Math.min(end, off + len) - off;
  return s < e ? [s, e] : null;
}

/** Boxes to paint on page i: masked findings (labelled), wrapped continuations, manual boxes, optionally all text. */
export function pdfBoxes(st: PdfState, res: MaskRes, s: Settings, i: number): { boxes: RenderBox[]; findings: number } {
  const o = imageOptions(s);
  const p = st.pages[i];
  const out: RenderBox[] = [];
  let findings = 0;
  for (const r of res.replacements) {
    const sp = local(st, i, r.start, r.end);
    if (!sp) continue;
    findings++;
    for (const box of spanBoxes(p.text, sp[0], sp[1], o.pad, p.w, p.h)) out.push({ box, label: r.id ? r.placeholder : undefined });
    for (const c of p.text.cont ?? []) if (c.at === sp[1] - 1) for (const box of spanBoxes(p.text, c.start, c.end, o.pad, p.w, p.h)) out.push({ box });
  }
  if (o.allText) {
    const t = p.text;
    for (let a = 0; a < t.text.length; ) {
      if (!t.boxes[a]) {
        a++;
        continue;
      }
      let b = a;
      while (b < t.text.length && t.boxes[b] && t.lines[b] === t.lines[a]) b++;
      for (const box of spanBoxes(t, a, b, o.pad, p.w, p.h)) out.push({ box });
      a = b;
    }
  }
  for (const m of st.manual) if (m.page === i) out.push({ box: m.box, label: m.type === 'AREA' ? undefined : m.type });
  return { boxes: out, findings };
}

const toJpeg = (c: HTMLCanvasElement) =>
  new Promise<Uint8Array>((res, rej) => c.toBlob((b) => (b ? b.arrayBuffer().then((a) => res(new Uint8Array(a)), rej) : rej(new Error('the page could not be encoded'))), 'image/jpeg', 0.85));

/**
 * Each page rendered as a viewer shows it, boxes painted over the pixels, then read again: where a
 * masked value is still readable it is covered too and the check repeats once. The pages become
 * an image-only PDF; pages over the limit are left out.
 */
export async function redactPdf(st: PdfState, res: MaskRes, s: Settings, key: string, progress: (msg: string) => void = () => {}): Promise<PdfOutput> {
  const t0 = performance.now();
  const check = stopper();
  const { doc } = await docOf(st);
  const o = pdfOptions(s);
  const io = imageOptions(s);
  const langs = ocrLangs(s);
  const values = [...new Map(res.replacements.filter((r) => r.id).map((r) => [r.original, r.placeholder])).entries()].filter(([v]) => v.replace(/\s/g, '').length >= 4);
  const pages: PdfPageOut[] = [];
  for (let i = 0; i < st.pages.length; i++) {
    check();
    progress(`Redacting page ${i + 1} of ${st.pages.length}…`);
    const p = st.pages[i];
    const page = await doc.getPage(i + 1);
    const k = Math.min(o.dpi / 72, 5000 / Math.max(p.w, p.h));
    const canvas = await renderPage(page, k);
    page.cleanup();
    try {
      const ctx = canvas.getContext('2d')!;
      const { boxes: first, findings } = pdfBoxes(st, res, s, i);
      let boxes = first;
      paintBoxes(ctx, boxes, io.labels, k);
      const verify: VerifyReport = { ran: false, covered: 0, readable: [] };
      if (io.verify && values.length && findings > 0) {
        verify.ran = true;
        progress(`Checking page ${i + 1} of ${st.pages.length}…`);
        for (let pass = 0; pass < 2; pass++) {
          const again = await readPixels(canvasBitmap(canvas), langs, { qr: false, ocr: true, upscale: o.dpi < 150 });
          const t = ocrText(again.ocr);
          const extra: RenderBox[] = [];
          const left: string[] = [];
          for (const [value, placeholder] of values) {
            const spans = findValue(t, value);
            if (!spans.length) continue;
            left.push(value);
            for (const sp of spans) for (const box of spanBoxes(t, sp.start, sp.end, io.pad * 1.5, canvas.width, canvas.height)) extra.push({ box, label: placeholder });
          }
          if (!extra.length) break;
          if (pass === 1) {
            verify.readable = left;
            break;
          }
          verify.covered += extra.length;
          paintBoxes(ctx, extra, io.labels);
          boxes = [...boxes, ...extra.map((b) => ({ ...b, box: scaleBox(b.box, 1 / k) }))];
        }
      }
      pages.push({ jpeg: await toJpeg(canvas), wPx: canvas.width, hPx: canvas.height, boxes, verify });
    } finally {
      release(canvas);
    }
  }
  check();
  const bytes = writeImagePdf(pages.map((pg, i) => ({ jpeg: pg.jpeg, wPx: pg.wPx, hPx: pg.hPx, wPt: st.pages[i].w, hPt: st.pages[i].h })));
  const verify: VerifyReport = {
    ran: pages.some((pg) => pg.verify.ran),
    covered: pages.reduce((n, pg) => n + pg.verify.covered, 0),
    readable: [...new Set(pages.flatMap((pg) => pg.verify.readable))],
  };
  return { bytes, key, pages, verify, ms: Math.round(performance.now() - t0) };
}

/** A page of the original for the review, `scale` pixels per point. */
export async function pagePreview(st: PdfState, i: number, scale: number): Promise<ImageBitmap> {
  const { doc } = await docOf(st);
  const page = await doc.getPage(i + 1);
  const canvas = await renderPage(page, scale);
  page.cleanup();
  try {
    return await createImageBitmap(canvas);
  } finally {
    release(canvas);
  }
}
