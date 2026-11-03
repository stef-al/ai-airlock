// pdf.js, from memory: the legacy build (it carries polyfills; the modern one needs features such as
// Map.getOrInsertComputed), an inline worker, fonts and WebAssembly decoders from the embedded assets.
import { AnnotationMode, getDocument, GlobalWorkerOptions, OPS, PasswordException, PasswordResponses, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?worker&inline';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { assetBytes } from './assets';
import type { Box } from './ocrTypes';
import type { LayerItem, PageAnnot } from './pdftext';

export type { PDFDocumentProxy, PDFPageProxy };

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

export class PdfPasswordError extends Error {
  constructor(public wrong: boolean) {
    super(wrong ? 'the password is not correct' : 'this PDF is protected by a password');
  }
}

export interface OpenPdf {
  doc: PDFDocumentProxy;
  close(): Promise<void>;
}

/** Open a PDF (the bytes are copied: pdf.js hands its buffer over to its worker). */
export async function openPdf(bytes: Uint8Array, password?: string): Promise<OpenPdf> {
  if (!port) {
    port = new PdfWorker();
    GlobalWorkerOptions.workerPort = port;
  }
  const task = getDocument({
    data: bytes.slice(),
    password,
    BinaryDataFactory: EmbeddedData as never,
    // the factory ignores these; pdf.js only requires them to be set (with a trailing slash)
    standardFontDataUrl: 'embedded/',
    wasmUrl: 'embedded/',
    useWorkerFetch: false,
    // fonts a PDF does not embed come from the bundled standard fonts, never from a url()/local() font
    useSystemFonts: false,
    enableXfa: false,
    isEvalSupported: false,
    stopAtErrors: false,
  } as never);
  try {
    const doc = await task.promise;
    return { doc, close: () => task.destroy() };
  } catch (e) {
    void task.destroy();
    if (e instanceof PasswordException || (e as { name?: string }).name === 'PasswordException') throw new PdfPasswordError((e as PasswordException).code === PasswordResponses.INCORRECT_PASSWORD);
    throw e;
  }
}

export interface PdfInventory {
  pages: number;
  /** Info dictionary fields: [name, value] */
  info: [string, string][];
  xmp: boolean;
  attachments: string[];
  scripts: boolean;
  bookmarks: number;
  fields: number;
  signatures: number;
  hiddenLayers: string[];
  /** saved versions in the file (incremental updates keep earlier content) */
  revisions: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v && typeof v === 'object' && 'name' in v ? String((v as { name: unknown }).name) : '');

/** What the file carries besides its pages: all of it is left out of the redacted copy. */
export async function inventory(doc: PDFDocumentProxy, bytes: Uint8Array): Promise<PdfInventory> {
  const safe = async <T,>(f: () => Promise<T>, d: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return d;
    }
  };
  const meta = await safe(() => doc.getMetadata(), null);
  const info: [string, string][] = [];
  const raw = (meta?.info ?? {}) as Record<string, unknown>;
  for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) if (str(raw[k])) info.push([k, str(raw[k])]);
  for (const [k, v] of Object.entries((raw.Custom ?? {}) as Record<string, unknown>)) if (str(v)) info.push([k, str(v)]);
  const attachments = await safe(async () => [...((await doc.getAttachments()) ?? new Map()).values()].map((a) => str((a as { filename?: unknown }).filename) || 'unnamed'), [] as string[]);
  const scripts = await safe(async () => (await doc.hasJSActions()) || ((await doc.getJSActions()) ?? new Map()).size > 0, false);
  const countOutline = (items: { items?: unknown[] }[] | null): number => (items ?? []).reduce((n, i) => n + 1 + countOutline((i.items ?? []) as { items?: unknown[] }[]), 0);
  const bookmarks = await safe(async () => countOutline((await doc.getOutline()) as { items?: unknown[] }[] | null), 0);
  const fieldMap = await safe(async () => (await doc.getFieldObjects()) ?? new Map<string, object[]>(), new Map<string, object[]>());
  const fields = [...fieldMap.values()].flat() as { type?: string }[];
  const hiddenLayers = await safe(async () => {
    const cfg = await doc.getOptionalContentConfig();
    const out: string[] = [];
    for (const [, g] of cfg as unknown as Iterable<[string, { name: string | null; visible: boolean }]>) if (!g.visible) out.push(g.name || 'unnamed layer');
    return out;
  }, [] as string[]);
  let revisions = 0;
  const eof = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
  for (let i = 0; i + 5 <= bytes.length; i++) if (bytes[i] === 0x25 && eof.every((b, k) => bytes[i + k] === b)) revisions++;
  return {
    pages: doc.numPages,
    info,
    xmp: !!meta?.metadata,
    attachments,
    scripts,
    bookmarks,
    fields: fields.filter((f) => f.type !== 'signature').length,
    signatures: fields.filter((f) => f.type === 'signature').length,
    hiddenLayers,
    revisions: Math.max(1, revisions),
  };
}

export interface PageRead {
  /** page size in points (rotation applied) */
  w: number;
  h: number;
  items: LayerItem[];
  annots: PageAnnot[];
  /** what the report lists for this page */
  dropped: { links: number; comments: number; attachments: number };
  /** the page paints raster images */
  images: boolean;
  /** lowest native resolution (pixels per inch as placed) of the images covering 2%+ of the page; 0 if none */
  imageDpi: number;
}

interface Annot {
  subtype?: string;
  rect?: number[];
  hidden?: boolean;
  noView?: boolean;
  contentsObj?: { str?: string };
  url?: string;
  unsafeUrl?: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: unknown;
  alternativeText?: string;
  checkBox?: boolean;
  radioButton?: boolean;
  file?: { filename?: string };
}

const IMAGE_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask].filter((x) => typeof x === 'number'));

/** The text layer, annotations and whether the page shows raster images (then it gets OCR). */
export async function readPage(page: PDFPageProxy): Promise<PageRead> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { fontFamily?: string; ascent?: number; descent?: number; vertical?: boolean }>;
  // embedded fonts often lack the fixed-pitch flag: a font whose items all advance the same
  // amount per character is monospace (indentation of code and YAML is rebuilt from it)
  const perChar = new Map<string, number[]>();
  for (const it of content.items) if ('str' in it && it.str.trim().length >= 4 && it.width > 0) (perChar.get(it.fontName) ?? perChar.set(it.fontName, []).get(it.fontName)!).push(it.width / it.str.length);
  const fixed = (font: string) => {
    const v = perChar.get(font) ?? [];
    return v.length >= 3 && Math.max(...v) / Math.min(...v) <= 1.02;
  };
  const items: LayerItem[] = [];
  for (const it of content.items) {
    if (!('str' in it)) continue;
    const st = styles[it.fontName] ?? {};
    items.push({
      str: it.str,
      tx: Util.transform(vp.transform, it.transform),
      // vertical writing advances along the height
      width: (st.vertical ? it.height : it.width) * vp.scale,
      eol: it.hasEOL,
      ascent: st.ascent,
      descent: st.descent,
      family: st.fontFamily !== 'monospace' && fixed(it.fontName) ? 'monospace' : st.fontFamily,
    });
  }
  const rect = (r?: number[]): Box | null => {
    if (!r || r.length < 4) return null;
    const [x0, y0] = vp.convertToViewportPoint(r[0], r[1]) as number[];
    const [x1, y1] = vp.convertToViewportPoint(r[2], r[3]) as number[];
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  };
  const annots: PageAnnot[] = [];
  const dropped = { links: 0, comments: 0, attachments: 0 };
  const seen = new Set<string>();
  for (const a of (await page.getAnnotations({ intent: 'display' })) as Annot[]) {
    const visible = !a.hidden && !a.noView;
    const comment = a.contentsObj?.str?.trim() ?? '';
    switch (a.subtype) {
      case 'Link': {
        const url = a.url ?? a.unsafeUrl;
        if (!url) break;
        dropped.links++;
        if (seen.has(url)) break;
        seen.add(url);
        annots.push({ label: 'Link', text: url, box: null });
        break;
      }
      case 'Widget': {
        if (a.fieldType === 'Sig' || a.checkBox || a.radioButton) break;
        const v = Array.isArray(a.fieldValue) ? a.fieldValue.join(', ') : str(a.fieldValue);
        if (!v.trim()) break;
        const name = (a.alternativeText || a.fieldName || 'field').replace(/\s+/g, ' ').slice(0, 60);
        // the value shows inside the field: its rectangle is covered when it holds a finding
        annots.push({ label: `Form field "${name}"`, text: v, box: visible ? rect(a.rect) : null });
        break;
      }
      case 'FreeText':
        if (comment) annots.push({ label: 'Text box', text: comment, box: visible ? rect(a.rect) : null });
        break;
      case 'Popup':
        break; // repeats its parent's contents
      case 'FileAttachment':
        dropped.attachments++;
        if (comment) annots.push({ label: 'Attachment note', text: comment, box: null });
        break;
      default:
        if (comment) {
          dropped.comments++;
          annots.push({ label: 'Comment', text: comment, box: null });
        }
    }
  }
  let images = false;
  let imageDpi = 0;
  try {
    const ops = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE });
    // follow the transformation matrix to know how large each image is drawn (in points)
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    const area = vp.width * vp.height;
    ops.fnArray.forEach((fn, k) => {
      const a = ops.argsArray[k] as unknown[] | null;
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform && a?.length === 6) ctm = Util.transform(ctm, a as number[]);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        const m = a?.[0];
        if (Array.isArray(m) && m.length === 6) ctm = Util.transform(ctm, m as number[]);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (IMAGE_OPS.has(fn)) {
        images = true;
        const img = a?.[0] as { width?: number; height?: number } | undefined;
        const [w, h] = fn === OPS.paintImageXObject ? [Number(a?.[1]), Number(a?.[2])] : [Number(img?.width), Number(img?.height)];
        const sx = Math.hypot(ctm[0], ctm[1]);
        const sy = Math.hypot(ctm[2], ctm[3]);
        if (w > 0 && h > 0 && sx * sy >= 0.02 * area) {
          const dpi = Math.min(w / sx, h / sy) * 72;
          imageDpi = imageDpi ? Math.min(imageDpi, dpi) : dpi;
        }
      }
    });
  } catch {
    images = true;
  }
  return { w: vp.width, h: vp.height, items, annots, dropped, images, imageDpi: Math.round(imageDpi) };
}

/** Render a page (with the appearance of its annotations, as a viewer shows it) at `scale` pixels per point. */
export async function renderPage(page: PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: AnnotationMode.ENABLE, background: '#ffffff' } as never).promise;
  return canvas;
}

/** Character widths for placing text inside an item: a canvas font of the same generic family. */
export function canvasMeasure(): (ch: string, family: string) => number {
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
  const cache = new Map<string, number>();
  let font = '';
  return (ch, family) => {
    const key = family + '\u0000' + ch;
    let w = cache.get(key);
    if (w === undefined) {
      const f = `100px ${family === 'monospace' || family === 'serif' ? family : 'sans-serif'}`;
      if (f !== font) ctx.font = font = f;
      w = ctx.measureText(ch).width;
      cache.set(key, w);
    }
    return w;
  };
}
