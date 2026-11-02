import OcrWorker from './ocr.worker?worker&inline';
import { assetBytes } from './assets';
import type { OcrLang } from './assetList';
import type { OcrReq, OcrResult } from './ocrTypes';

let worker: Worker | null = null;
let seq = 0;
let ready = '';
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

function spawn(): Worker {
  if (worker) return worker;
  worker = new OcrWorker();
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    if (e.data.ok) p?.resolve(e.data.result);
    else p?.reject(new Error(e.data.error));
  };
  return worker;
}

function call<T>(req: OcrReq, transfer: Transferable[] = []): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    spawn().postMessage({ id, req }, transfer);
  });
}

/** Stops the OCR worker (cancel / forget): it holds images and text in its memory. */
export function stopOcr(): void {
  worker?.terminate();
  worker = null;
  ready = '';
  for (const p of pending.values()) p.reject(new Error('stopped'));
  pending.clear();
}

/** Recognise text in an encoded image (PNG/JPEG/BMP bytes). */
export async function ocrImage(image: Uint8Array, langs: OcrLang[] = ['eng']): Promise<OcrResult> {
  const key = langs.join('+');
  if (ready !== key) {
    const wasm = await assetBytes('tess/core.wasm');
    const data = await Promise.all(langs.map(async (code) => ({ code, gz: await assetBytes(`tess/${code}.traineddata.gz`) })));
    await call({ type: 'init', wasm, langs: data }, [wasm.buffer, ...data.map((d) => d.gz.buffer)]);
    ready = key;
  }
  return call<OcrResult>({ type: 'recognize', image }, [image.buffer]);
}
