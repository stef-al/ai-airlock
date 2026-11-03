import type { Box, OcrResult } from './ocrTypes';

export interface QrCode {
  /** decoded content */
  text: string;
  box: Box;
}

/** tuning knobs of the face search (the metrics script tries values; the app uses the defaults) */
export interface FaceOpts {
  minTile?: number;
  maxTiles?: number;
  minScore?: number;
}

export interface FaceBox {
  box: Box;
  /** detector score 0..1 */
  score: number;
}

export interface ReadResult {
  width: number;
  height: number;
  /** the image was enlarged by this factor for OCR (boxes are in original pixels) */
  scale: number;
  /** light text on a dark background was inverted for OCR */
  inverted: boolean;
  ocr: OcrResult;
  qr: QrCode[];
  /** faces (when asked for), boxes enlarged for redaction */
  faces: FaceBox[];
  faceMs?: number;
  ms: number;
}

export interface RenderBox {
  box: Box;
  /** placeholder written into the box (white on black) */
  label?: string;
}

export type MediaReq =
  | { type: 'init'; wasm: Uint8Array; langs: { code: string; gz: Uint8Array }[] }
  /**
   * OCR (and QR codes) of an encoded image file or of decoded pixels (a rendered PDF page).
   * `upscale` (default on) enlarges screenshot-sized images for OCR; `ocr: false` only looks for QR codes.
   */
  | { type: 'read'; image: Uint8Array | ImageBitmap; qr: boolean; ocr?: boolean; upscale?: boolean; faces?: boolean; faceOpts?: FaceOpts }
  /** load the face detector (TF.js WebAssembly backend and BlazeFace) from bytes */
  | { type: 'faces-init'; model: Uint8Array; weights: Uint8Array; simd: Uint8Array; plain: Uint8Array }
  /** paint the boxes over the image and encode a new file (no metadata survives) */
  | { type: 'render'; image: Uint8Array; boxes: RenderBox[]; mime: 'image/png' | 'image/jpeg'; labels: boolean };

export interface RenderResult {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}
