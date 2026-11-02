import { Client } from '../ui/engineClient';
import { assetBytes } from './assets';
import type { OcrLang } from './assetList';
import MediaWorker from './media.worker?worker&inline';
import type { MediaReq, ReadResult, RenderBox, RenderResult } from './protocol';

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

/** OCR and QR codes of an image file (the bytes are copied, the caller keeps its own). */
export async function readImage(image: Uint8Array, langs: OcrLang[], qr: boolean): Promise<ReadResult> {
  for (let attempt = 0; ; attempt++) {
    await ensureInit(langs);
    const copy = image.slice();
    try {
      return await media.call<ReadResult>({ type: 'read', image: copy, qr }, { transfer: [copy.buffer], timeoutMs: 180_000 });
    } catch (e) {
      // the worker was replaced between init and read (cancel): initialise again once
      if (attempt === 0 && /not initialised/.test((e as Error).message)) {
        initKey = '';
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
