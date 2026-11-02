// the legacy build carries polyfills (the modern one needs features such as Map.getOrInsertComputed)
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?worker&inline';
import { assetBytes } from './assets';

/** pdf.js asks this for fonts and WebAssembly decoders: they come from the embedded assets. */
class EmbeddedData {
  constructor(_urls: unknown) {}
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    if (kind === 'standardFontDataUrl') return assetBytes('pdf/fonts/' + filename);
    if (kind === 'wasmUrl') return assetBytes('pdf/wasm/' + filename);
    throw new Error(`${filename} is not bundled`);
  }
}

let port: Worker | null = null;

export interface PdfPageResult {
  pages: number;
  text: string;
  width: number;
  height: number;
  png: Uint8Array;
}

/** Spike: open a PDF, read page 1's text layer and render it at 2x. */
export async function pdfFirstPage(data: Uint8Array): Promise<PdfPageResult> {
  if (!port) {
    port = new PdfWorker();
    GlobalWorkerOptions.workerPort = port;
  }
  const task = getDocument({
    data,
    BinaryDataFactory: EmbeddedData as never,
    // the factory ignores these; pdf.js only requires them to be set (with a trailing slash)
    standardFontDataUrl: 'embedded/',
    wasmUrl: 'embedded/',
    useWorkerFetch: false,
    enableXfa: false,
  } as never);
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const text = (await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport } as never).promise;
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('render failed'))), 'image/png'));
    return { pages: doc.numPages, text, width: canvas.width, height: canvas.height, png: new Uint8Array(await blob.arrayBuffer()) };
  } finally {
    await task.destroy();
  }
}
