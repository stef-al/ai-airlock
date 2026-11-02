/// <reference lib="webworker" />
// OCR worker: Tesseract (WebAssembly) started from bytes the page hands over. No fetch, no
// importScripts: the engine and the language data are embedded in the HTML file.
import TesseractCore, { type TessBaseAPI, type TessModule } from 'tesseract.js-core/tesseract-core-simd-lstm.js';
import type { OcrReq, OcrResult, OcrWord } from './ocrTypes';

let tess: TessModule | null = null;
let api: TessBaseAPI | null = null;
let langs = '';

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface JBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface JSymbol {
  text: string;
  confidence: number;
  bbox: JBox;
}
interface JWord {
  text: string;
  confidence: number;
  bbox: JBox;
  symbols?: JSymbol[];
}
interface JLine {
  words: JWord[];
}
interface JBlock {
  paragraphs?: { lines: JLine[] }[];
}

const box = (b: JBox): [number, number, number, number] => [b.x0, b.y0, b.x1, b.y1];

function recognize(image: Uint8Array): OcrResult {
  if (!tess || !api) throw new Error('OCR is not initialised');
  tess.FS.writeFile('/input', image);
  if (api.SetImageFile(1, 0) === 1) throw new Error('the image could not be read');
  api.Recognize(null);
  const json = JSON.parse(api.GetJSONText()) as { blocks: JBlock[] | null };
  const words: OcrWord[] = [];
  let line = 0;
  for (const b of json.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines) {
        for (const w of l.words) {
          words.push({ text: w.text, conf: w.confidence, box: box(w.bbox), line, chars: (w.symbols ?? []).map((s) => ({ text: s.text, conf: s.confidence, box: box(s.bbox) })) });
        }
        line++;
      }
    }
  }
  const out: OcrResult = { text: api.GetUTF8Text(), conf: api.MeanTextConf(), words };
  api.Clear();
  return out;
}

self.onmessage = async (e: MessageEvent<{ id: number; req: OcrReq }>) => {
  const { id, req } = e.data;
  const reply = (m: object) => (self as unknown as Worker).postMessage({ id, ...m });
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
      case 'recognize':
        reply({ ok: true, result: recognize(req.image) });
        break;
    }
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
