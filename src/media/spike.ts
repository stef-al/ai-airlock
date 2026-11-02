// Phase 0 spike hook (media build only): lets scripts/smoke-media.mjs drive OCR, pdf.js and the face
// model in the real built file. Replaced by the image review UI in phase A.
import { faceSpike } from './faces';
import { ocrImage } from './ocr';
import { pdfFirstPage } from './pdf';
import type { OcrLang } from './assetList';

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

(globalThis as unknown as { __airlockSpike: unknown }).__airlockSpike = {
  async ocr(base64: string, langs?: OcrLang[]) {
    const t0 = performance.now();
    const r = await ocrImage(b64(base64), langs);
    return { text: r.text, conf: r.conf, words: r.words.length, firstChars: r.words[0]?.chars.slice(0, 3), ms: Math.round(performance.now() - t0) };
  },
  async pdf(base64: string) {
    const t0 = performance.now();
    const p = await pdfFirstPage(b64(base64));
    const o = await ocrImage(p.png.slice());
    return { pages: p.pages, text: p.text, size: [p.width, p.height], ocr: o.text, ms: Math.round(performance.now() - t0) };
  },
  async faces(base64: string) {
    const bmp = await createImageBitmap(new Blob([b64(base64) as BlobPart]));
    return faceSpike(bmp);
  },
};
