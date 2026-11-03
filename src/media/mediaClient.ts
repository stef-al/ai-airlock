import { Client } from '../ui/engineClient';
import { assetBytes } from './assets';
import type { OcrLang } from './assetList';
import MediaWorker from './media.worker?worker&inline';
import type { FaceOpts, MediaReq, ReadResult, RenderBox, RenderResult } from './protocol';

/** One media worker, jobs run one after another; cancel terminates it (OCR state is rebuilt). */
export const media = new Client<MediaReq>(() => new MediaWorker());

let initKey = '';
let initSpawn = -1;

async function ensureInit(langs: OcrLang[]): Promise<void> {
  const key = langs.join('+');
  if (media.alive && initKey === key && initSpawn === media.spawns) return;
  const wasm = await assetBytes('tess/core.wasm');
  const data = await Promise.all(langs.map(async (code) => ({ code, gz: await assetBytes(`tess/${code}.traineddata.gz`) })));
  await media.call({ type: 'init', wasm, langs: data }, { transfer: [wasm.buffer, ...data.map((d) => d.gz.buffer)], timeoutMs: 120_000 });
  initKey = key;
  initSpawn = media.spawns;
}

let facesSpawn = -1;
let faceBackend = '';

/** The face detector in the worker (TF.js WebAssembly backend and BlazeFace, from embedded bytes). */
export async function ensureFaces(): Promise<string> {
  if (media.alive && facesSpawn === media.spawns) return faceBackend;
  const [model, weights, simd, plain] = await Promise.all(['faces/blazeface.json', 'faces/blazeface.bin', 'faces/tfjs-simd.wasm', 'faces/tfjs.wasm'].map(assetBytes));
  const r = await media.call<{ backend: string }>({ type: 'faces-init', model, weights, simd, plain }, { transfer: [model.buffer, weights.buffer, simd.buffer, plain.buffer], timeoutMs: 120_000 });
  facesSpawn = media.spawns;
  faceBackend = r.backend;
  return faceBackend;
}

/** the worker was replaced between init and read (cancel): initialise again once */
const lostInit = (e: unknown) => /not initialised|not loaded/.test((e as Error).message);

/** OCR, QR codes and faces of an image file (the bytes are copied, the caller keeps its own). */
export async function readImage(image: Uint8Array, langs: OcrLang[], qr: boolean, faces = false, ocr = true, faceOpts?: FaceOpts): Promise<ReadResult> {
  for (let attempt = 0; ; attempt++) {
    if (ocr) await ensureInit(langs);
    if (faces) await ensureFaces();
    const copy = image.slice();
    try {
      return await media.call<ReadResult>({ type: 'read', image: copy, qr, faces, ocr, faceOpts }, { transfer: [copy.buffer], timeoutMs: 180_000 });
    } catch (e) {
      if (attempt === 0 && lostInit(e)) {
        initKey = '';
        facesSpawn = -1;
        continue;
      }
      throw e;
    }
  }
}

export async function renderRedacted(image: Uint8Array, boxes: RenderBox[], mime: 'image/png' | 'image/jpeg', labels: boolean): Promise<RenderResult> {
  const copy = image.slice();
  return media.call<RenderResult>({ type: 'render', image: copy, boxes, mime, labels }, { transfer: [copy.buffer], timeoutMs: 120_000 });
}

/**
 * OCR and/or QR codes of decoded pixels (a rendered PDF page). `make` is called for each attempt:
 * the bitmap is handed over to the worker.
 */
export async function readPixels(make: () => Promise<ImageBitmap>, langs: OcrLang[], o: { qr: boolean; ocr: boolean; upscale: boolean; faces?: boolean }): Promise<ReadResult> {
  for (let attempt = 0; ; attempt++) {
    if (o.ocr) await ensureInit(langs);
    if (o.faces) await ensureFaces();
    const bmp = await make();
    try {
      return await media.call<ReadResult>({ type: 'read', image: bmp, ...o }, { transfer: [bmp], timeoutMs: 180_000 });
    } catch (e) {
      if (attempt === 0 && lostInit(e)) {
        initKey = '';
        facesSpawn = -1;
        continue;
      }
      throw e;
    }
  }
}
