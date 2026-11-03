// Image documents: OCR → text with character boxes → the usual detection and masking (engine
// worker) → boxes painted over a newly encoded copy → OCR of the copy to check nothing is left.
import type { Hit, Settings } from '../engine/light';
import type { MaskRes } from '../worker/protocol';
import { imageOptions, ocrLangs } from './options';

export { defaultOcrLangs, imageOptions, ocrLangs, readKey } from './options';
import { readImage, renderRedacted } from './mediaClient';
import { describeImage, type ImageMeta } from './metadata';
import { faceRegion, findValue, ocrText, padBox, regionSpans, spanBoxes, type OcrText, type Region } from './ocrdoc';

export { applyFixes } from './ocrdoc';
import type { Box } from './ocrTypes';
import type { ReadResult, RenderBox } from './protocol';

export interface ManualBox {
  box: Box;
  /** AREA (anything), FACE or SIGNATURE */
  type: string;
}

export interface VerifyReport {
  ran: boolean;
  /** further places where a masked value was still readable and got covered */
  covered: number;
  /** masked values the check could still read after that */
  readable: string[];
}

export interface ImageOutput {
  bytes: Uint8Array;
  mime: string;
  /** what the output was made from (render again when it changes) */
  key: string;
  boxes: RenderBox[];
  verify: VerifyReport;
}

export interface ImageState {
  bytes: Uint8Array;
  meta: ImageMeta;
  width: number;
  height: number;
  read?: ReadResult;
  /** current OCR text and character boxes (corrections applied) */
  text?: OcrText;
  regions: Region[];
  manual: ManualBox[];
  /** bumped when manual boxes change */
  rver: number;
  /** OCR settings the text was read with (read again when they change) */
  readKey?: string;
  out?: ImageOutput;
  rendering?: boolean;
  reviewed: boolean;
}

export function newImageState(bytes: Uint8Array): ImageState {
  return { bytes, meta: describeImage(bytes), width: 0, height: 0, regions: [], manual: [], rver: 0, reviewed: false };
}

export const isImage = (bytes: Uint8Array) => describeImage(bytes.subarray(0, 64)).format !== null;

/** OCR (and QR codes) of the image; the text that detection runs on, with its boxes. */
export async function readImageText(img: ImageState, s: Settings): Promise<{ read: ReadResult; text: OcrText; regions: Region[]; width: number; height: number }> {
  const o = imageOptions(s);
  const read = await readImage(img.bytes, ocrLangs(s), o.qr, o.faces);
  const regions: Region[] = [...read.qr.map((q) => ({ label: 'QR code', text: q.text, box: q.box })), ...read.faces.map((f) => faceRegion(f.box, f.score))];
  return { read, text: ocrText(read.ocr, regions, read.width), regions, width: read.width, height: read.height };
}

/** QR codes and faces are masked: each becomes a finding the user can still keep. */
export function regionHits(t: OcrText, regions: Region[]): Hit[] {
  const spans = regionSpans(t, regions);
  return regions.flatMap((g, i) => {
    const sp = spans[i];
    if (!sp) return [];
    const face = g.type === 'FACE';
    return [
      {
        start: sp.start,
        end: sp.end,
        type: face ? 'FACE' : 'QR',
        category: face ? ('personal' as const) : ('custom' as const),
        detector: face ? 'media.face' : 'media.qr',
        confidence: face ? Math.round((g.score ?? 1) * 100) / 100 : 1,
        reason: face ? `face found by the detector (score ${Math.round((g.score ?? 1) * 100)}%)` : 'QR code: always masked, whatever it contains',
        priority: 5,
        user: 'region' as const,
      },
    ];
  });
}

/** Boxes to paint: masked findings (labelled with their placeholder), manual boxes, optionally all text. */
export function imageBoxes(img: ImageState, res: MaskRes, s: Settings): RenderBox[] {
  const o = imageOptions(s);
  const t = img.text;
  const out: RenderBox[] = [];
  if (!t) return out;
  for (const r of res.replacements) {
    for (const box of spanBoxes(t, r.start, r.end, o.pad, img.width, img.height)) out.push({ box, label: r.id ? r.placeholder : undefined });
    // a token that ends at the right edge may continue on the next line: cover that part too
    for (const c of t.cont ?? []) if (c.at === r.end - 1) for (const box of spanBoxes(t, c.start, c.end, o.pad, img.width, img.height)) out.push({ box });
  }
  if (o.allText && img.read) for (const w of img.read.ocr.words) if (w.text.trim()) out.push({ box: padBox(w.box, o.pad, img.width, img.height) });
  for (const m of img.manual) out.push({ box: m.box, label: m.type === 'AREA' ? undefined : m.type });
  return out;
}

export const outputMime = (img: ImageState): 'image/png' | 'image/jpeg' => (img.meta.format === 'jpeg' ? 'image/jpeg' : 'image/png');

/**
 * Paint the boxes into a new file, then read the result again: every place where a masked value
 * is still readable (a second occurrence nobody flagged, a glyph sticking out of its box) is
 * covered as well, and the check repeats once. What it can still read is reported.
 */
export async function redact(img: ImageState, res: MaskRes, s: Settings, key: string): Promise<ImageOutput> {
  const o = imageOptions(s);
  let boxes = imageBoxes(img, res, s);
  const mime = outputMime(img);
  let out = await renderRedacted(img.bytes, boxes, mime, o.labels);
  const verify: VerifyReport = { ran: false, covered: 0, readable: [] };
  const values = [...new Map(res.replacements.filter((r) => r.id).map((r) => [r.original, r.placeholder])).entries()].filter(([v]) => v.replace(/\s/g, '').length >= 4);
  if (o.verify && values.length) {
    verify.ran = true;
    for (let pass = 0; pass < 2; pass++) {
      const again = await readImage(out.bytes, ocrLangs(s), false);
      const t = ocrText(again.ocr);
      const extra: RenderBox[] = [];
      const left: string[] = [];
      for (const [value, placeholder] of values) {
        const spans = findValue(t, value);
        if (!spans.length) continue;
        left.push(value);
        for (const sp of spans) for (const box of spanBoxes(t, sp.start, sp.end, o.pad * 1.5, out.width, out.height)) extra.push({ box, label: placeholder });
      }
      if (!extra.length) break;
      if (pass === 1) {
        verify.readable = left;
        break;
      }
      verify.covered += extra.length;
      boxes = [...boxes, ...extra];
      out = await renderRedacted(img.bytes, boxes, mime, o.labels);
    }
  }
  return { bytes: out.bytes, mime: out.mime, key, boxes, verify };
}
