/// <reference lib="webworker" />
// Media worker: OCR with Tesseract (WebAssembly, started from bytes the page hands over), QR codes,
// and painting redactions into a newly encoded image. No fetch, no importScripts.
import jsQR from 'jsqr';
import TesseractCore, { type TessBaseAPI, type TessModule } from 'tesseract.js-core/tesseract-core-simd-lstm.js';
import type { Box, OcrResult, OcrWord } from './ocrTypes';
import { detectFaces, facesReady, initFaces } from './faces';
import { repairOcr } from './ocrfix';
import { paintBoxes } from './paint';
import type { FaceOpts, MediaReq, QrCode, ReadResult, RenderBox, RenderResult } from './protocol';

let tess: TessModule | null = null;
let api: TessBaseAPI | null = null;
let langs = '';

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode with the EXIF orientation applied (the redacted copy is stored upright, without EXIF). */
async function decode(image: Uint8Array): Promise<ImageBitmap> {
  const blob = new Blob([image as BlobPart]);
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(blob);
  }
}

interface JBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface JBlock {
  paragraphs?: { lines: { words: { text: string; confidence: number; bbox: JBox; symbols?: { text: string; confidence: number; bbox: JBox }[] }[] }[] }[];
}

/** OCR of a PPM image; boxes are divided by `scale` to get back to original pixels. */
function recognize(ppm: Uint8Array, scale: number): OcrResult {
  if (!tess || !api) throw new Error('OCR is not initialised');
  tess.FS.writeFile('/input', ppm);
  if (api.SetImageFile(1, 0) === 1) throw new Error('the image could not be read');
  api.Recognize(null);
  const json = JSON.parse(api.GetJSONText()) as { blocks: JBlock[] | null };
  const b = (x: JBox): Box => [x.x0 / scale, x.y0 / scale, x.x1 / scale, x.y1 / scale];
  const words: OcrWord[] = [];
  let line = 0;
  for (const bl of json.blocks ?? []) {
    for (const p of bl.paragraphs ?? []) {
      for (const l of p.lines) {
        for (const w of l.words) words.push({ text: w.text, conf: w.confidence, box: b(w.bbox), line, chars: (w.symbols ?? []).map((s) => ({ text: s.text, conf: s.confidence, box: b(s.bbox) })) });
        line++;
      }
    }
  }
  const out: OcrResult = { text: api.GetUTF8Text(), conf: api.MeanTextConf(), words };
  api.Clear();
  return out;
}

/** Up to 5 QR codes: each one found is blanked out before looking for the next. */
function findQr(img: ImageData): QrCode[] {
  const out: QrCode[] = [];
  // large photos are scanned at a reduced size (QR codes stay readable)
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  let data = img;
  if (k < 1) {
    const c = new OffscreenCanvas(Math.round(img.width * k), Math.round(img.height * k));
    const x = c.getContext('2d')!;
    const src = new OffscreenCanvas(img.width, img.height);
    src.getContext('2d')!.putImageData(img, 0, 0);
    x.drawImage(src, 0, 0, c.width, c.height);
    data = x.getImageData(0, 0, c.width, c.height);
  }
  const px = new Uint8ClampedArray(data.data);
  for (let n = 0; n < 5; n++) {
    const code = jsQR(px, data.width, data.height, { inversionAttempts: 'attemptBoth' });
    if (!code) break;
    const L = code.location;
    const xs = [L.topLeftCorner.x, L.topRightCorner.x, L.bottomLeftCorner.x, L.bottomRightCorner.x];
    const ys = [L.topLeftCorner.y, L.topRightCorner.y, L.bottomLeftCorner.y, L.bottomRightCorner.y];
    // a real code has content and is about square (text can fool the finder pattern search)
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    if (!code.data || h === 0 || w / h < 0.7 || w / h > 1.4) break;
    // include the finder patterns' outer edge and a little quiet zone
    const m = 0.08 * (Math.max(...xs) - Math.min(...xs));
    const box: Box = [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m];
    out.push({ text: code.data, box: box.map((v) => v / k) as Box });
    for (let y = Math.max(0, Math.floor(box[1])); y < Math.min(data.height, Math.ceil(box[3])); y++) {
      for (let x = Math.max(0, Math.floor(box[0])); x < Math.min(data.width, Math.ceil(box[2])); x++) px.fill(255, (y * data.width + x) * 4, (y * data.width + x) * 4 + 4);
    }
  }
  return out;
}

async function read(image: Uint8Array | ImageBitmap, wantQr: boolean, wantOcr = true, upscale = true, wantFaces = false, faceOpts: FaceOpts = {}): Promise<ReadResult> {
  const t0 = performance.now();
  const bmp = image instanceof ImageBitmap ? image : await decode(image);
  const w = bmp.width;
  const h = bmp.height;
  // transparent pixels become white, as they look in a viewer
  const base = new OffscreenCanvas(w, h);
  const bx = base.getContext('2d', { willReadFrequently: true })!;
  bx.fillStyle = '#fff';
  bx.fillRect(0, 0, w, h);
  bx.drawImage(bmp, 0, 0);
  bmp.close();
  const basePx = bx.getImageData(0, 0, w, h);
  const qr = wantQr ? findQr(basePx) : [];
  let faces: ReadResult['faces'] = [];
  let faceMs: number | undefined;
  if (wantFaces) {
    if (!facesReady()) throw new Error('the face model is not loaded');
    const r = detectFaces(base, faceOpts);
    faces = r.faces;
    faceMs = r.ms;
  }
  if (!wantOcr) return { width: w, height: h, scale: 1, inverted: false, ocr: { text: '', conf: 0, words: [] }, qr, faces, faceMs, ms: Math.round(performance.now() - t0) };
  // Tesseract reads text best at 20-30 px: screenshot-sized images are enlarged
  const scale = upscale && Math.max(w, h) <= 2200 ? 2 : 1;
  const W = Math.round(w * scale);
  const H = Math.round(h * scale);
  const c = new OffscreenCanvas(W, H);
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(base, 0, 0, W, H);
  const px = cx.getImageData(0, 0, W, H).data;
  // light text on a dark background (dark mode) is inverted
  let lum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4 * 97) {
    lum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    n++;
  }
  const inverted = lum / Math.max(1, n) < 110;
  const head = new TextEncoder().encode(`P6\n${W} ${H}\n255\n`);
  const ppm = new Uint8Array(head.length + W * H * 3);
  ppm.set(head);
  for (let i = 0, o = head.length; i < px.length; i += 4, o += 3) {
    ppm[o] = inverted ? 255 - px[i] : px[i];
    ppm[o + 1] = inverted ? 255 - px[i + 1] : px[i + 1];
    ppm[o + 2] = inverted ? 255 - px[i + 2] : px[i + 2];
  }
  // word splits the pixels can settle: dropped underscores, monospace narrow glyphs, indentation
  const ocr = repairOcr(recognize(ppm, scale), basePx);
  return { width: w, height: h, scale, inverted, ocr, qr, faces, faceMs, ms: Math.round(performance.now() - t0) };
}

async function render(image: Uint8Array, boxes: RenderBox[], mime: string, labels: boolean): Promise<RenderResult> {
  const bmp = await decode(image);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d')!;
  x.drawImage(bmp, 0, 0);
  bmp.close();
  paintBoxes(x, boxes, labels);
  const blob = await c.convertToBlob({ type: mime, quality: 0.92 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, width: c.width, height: c.height };
}

self.onmessage = async (e: MessageEvent<{ id: number; req: MediaReq }>) => {
  const { id, req } = e.data;
  const reply = (m: object, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ id, ...m }, transfer);
  try {
    switch (req.type) {
      case 'init': {
        if (!tess) tess = await TesseractCore({ wasmBinary: req.wasm, print: () => {}, printErr: () => {} });
        const codes = req.langs.map((l) => l.code).join('+');
        if (codes !== langs) {
          for (const l of req.langs) tess.FS.writeFile(`./${l.code}.traineddata`, await gunzip(l.gz));
          api?.End();
          api = new tess.TessBaseAPI();
          // 1 = LSTM engine only (the bundled models have no legacy engine)
          if (api.Init(null, codes, 1) !== 0) throw new Error('OCR language data could not be loaded');
          api.SetVariable('preserve_interword_spaces', '1');
          langs = codes;
        }
        reply({ ok: true, result: { langs } });
        break;
      }
      case 'faces-init':
        reply({ ok: true, result: { backend: await initFaces(req) } });
        break;
      case 'read':
        reply({ ok: true, result: await read(req.image, req.qr, req.ocr ?? true, req.upscale ?? true, req.faces ?? false, req.faceOpts) });
        break;
      case 'render': {
        const r = await render(req.image, req.boxes, req.mime, req.labels);
        reply({ ok: true, result: r }, [r.bytes.buffer]);
        break;
      }
    }
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
