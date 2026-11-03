import type { Box, OcrResult } from './ocrTypes';

export interface QrCode {
  /** decoded content */
  text: string;
  box: Box;
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
  | { type: 'read'; image: Uint8Array | ImageBitmap; qr: boolean; ocr?: boolean; upscale?: boolean }
  /** paint the boxes over the image and encode a new file (no metadata survives) */
  | { type: 'render'; image: Uint8Array; boxes: RenderBox[]; mime: 'image/png' | 'image/jpeg'; labels: boolean };

export interface RenderResult {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}
