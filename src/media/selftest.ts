// Self-test hook of airlock-media.html, registered only when the file is opened with #selftest:
// scripts/metrics-media.ts and scripts/smoke-media.mjs drive the real pipeline (media worker,
// engine worker, redaction, verification) with images they generate. It only sees what they pass.
import { defaultSettings, mergeSettings, type Hit, type Settings } from '../engine/light';
import { engine } from '../ui/engineClient';
import type { AnalyzeRes, MaskRes } from '../worker/protocol';
import { imageBoxes, newImageState, ocrLangs, readImageText, redact, regionHits } from './image';
import { readImage } from './mediaClient';
import { ocrText } from './ocrdoc';
import { faceSpike } from './faces';
import { inventory, openPdf, renderPage } from './pdf';
import { closePdf, newPdfState, readPdf, redactPdf } from './pdfdoc';

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const EMPTY = { entries: [], counters: [], reservedIds: [], reservedFakes: [] };

async function processImage(base64: string, patch: Partial<Settings> = {}) {
  const t0 = performance.now();
  const s = mergeSettings(defaultSettings('US'), patch);
  const img = newImageState(b64(base64));
  const r = await readImageText(img, s);
  const state = { ...img, ...r };
  const text = r.text.text;
  const a = await engine.call<AnalyzeRes>({ type: 'analyze', docKey: 'selftest', text, settings: s, ocr: true });
  const regions = regionHits(r.text, r.regions);
  const hits: Hit[] = [...regions, ...a.hits.filter((h) => !regions.some((g) => g.start < h.end && h.start < g.end))].sort((x, y) => x.start - y.start);
  const m = await engine.call<MaskRes>({ type: 'mask', docKey: 'selftest', text, settings: s, format: 'prose', hits, mapping: EMPTY });
  const out = await redact(state, m, s, 'selftest');
  return {
    text,
    hits: hits.map((h) => ({ type: h.type, text: text.slice(h.start, h.end), conf: h.confidence })),
    boxes: imageBoxes(state, m, s).map((b) => b.box),
    finalBoxes: out.boxes.map((b) => b.box),
    output: m.output,
    image: toB64(out.bytes),
    mime: out.mime,
    verify: out.verify,
    meta: img.meta,
    read: { ms: r.read.ms, scale: r.read.scale, inverted: r.read.inverted, conf: r.read.ocr.conf, qr: r.read.qr },
    words: r.read.ocr.words.map((w) => ({ t: w.text, l: w.line, b: w.box.map(Math.round) })),
    ms: Math.round(performance.now() - t0),
  };
}

async function processPdf(base64: string, patch: Partial<Settings> = {}, password?: string) {
  const t0 = performance.now();
  const s = mergeSettings(defaultSettings('US'), patch);
  const st0 = { ...newPdfState(b64(base64)), password };
  try {
    const r = await readPdf(st0, s);
    const st = { ...st0, ...r };
    const a = await engine.call<AnalyzeRes>({ type: 'analyze', docKey: 'selftest-pdf', text: r.text, settings: s, ocr: r.usedOcr });
    const hits: Hit[] = [...r.extra, ...a.hits.filter((h) => !r.extra.some((g) => g.start < h.end && h.start < g.end))].sort((x, y) => x.start - y.start);
    const m = await engine.call<MaskRes>({ type: 'mask', docKey: 'selftest-pdf', text: r.text, settings: s, format: 'prose', hits, mapping: EMPTY });
    const out = await redactPdf(st, m, s, 'selftest');
    return {
      text: r.text,
      hits: hits.map((h) => ({ type: h.type, text: r.text.slice(h.start, h.end), conf: h.confidence, start: h.start, end: h.end })),
      output: m.output,
      values: m.replacements.filter((x) => x.id).map((x) => x.original),
      pdf: toB64(out.bytes),
      verify: out.verify,
      pages: r.pages.map((p, i) => ({ w: p.w, h: p.h, ocr: p.ocr, images: p.images, imageDpi: p.imageDpi, dropped: p.dropped, boxes: out.pages[i].boxes.length })),
      /** boxes painted on each page, in page points */
      pageBoxes: out.pages.map((p) => p.boxes.map((b) => b.box)),
      inv: r.inv,
      readMs: r.readMs,
      redactMs: out.ms,
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    await closePdf(st0.bytes);
  }
}

/** What a PDF holds (to check redacted copies): pages, text layer, annotations, metadata; optionally each page as a PNG. */
async function pdfInfo(base64: string, render = false) {
  const bytes = b64(base64);
  const o = await openPdf(bytes);
  try {
    const pages = [];
    for (let i = 1; i <= o.doc.numPages; i++) {
      const page = await o.doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const text = (await page.getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join('');
      const annots = (await page.getAnnotations()).length;
      let png = '';
      if (render) {
        const c = await renderPage(page, 150 / 72);
        const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('render failed'))), 'image/png'));
        png = toB64(new Uint8Array(await blob.arrayBuffer()));
      }
      pages.push({ w: vp.width, h: vp.height, text, annots, png });
    }
    return { inv: await inventory(o.doc, bytes), pages };
  } finally {
    await o.close();
  }
}

(globalThis as unknown as { __airlockSelfTest: unknown }).__airlockSelfTest = {
  processImage,
  /** plain OCR of an image (to check what a redacted copy still shows) */
  async readText(base64: string) {
    return ocrText((await readImage(b64(base64), ocrLangs(defaultSettings('US')), false)).ocr).text;
  },
  processPdf,
  pdfInfo,
  async faces(base64: string) {
    return faceSpike(await createImageBitmap(new Blob([b64(base64) as BlobPart])));
  },
};
