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
import { pdfFirstPage } from './pdf';

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

(globalThis as unknown as { __airlockSelfTest: unknown }).__airlockSelfTest = {
  processImage,
  /** plain OCR of an image (to check what a redacted copy still shows) */
  async readText(base64: string) {
    return ocrText((await readImage(b64(base64), ocrLangs(defaultSettings('US')), false)).ocr).text;
  },
  async pdf(base64: string) {
    const p = await pdfFirstPage(b64(base64));
    return { pages: p.pages, text: p.text, size: [p.width, p.height], png: toB64(p.png) };
  },
  async faces(base64: string) {
    return faceSpike(await createImageBitmap(new Blob([b64(base64) as BlobPart])));
  },
};
