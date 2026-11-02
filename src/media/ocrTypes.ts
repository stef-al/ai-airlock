/** [x0, y0, x1, y1] in image pixels */
export type Box = [number, number, number, number];

export interface OcrChar {
  text: string;
  conf: number;
  box: Box;
}
export interface OcrWord {
  text: string;
  conf: number;
  box: Box;
  /** index of the text line in reading order */
  line: number;
  chars: OcrChar[];
}
export interface OcrResult {
  text: string;
  /** mean word confidence 0..100 */
  conf: number;
  words: OcrWord[];
}

export type OcrReq =
  | { type: 'init'; wasm: Uint8Array; langs: { code: string; gz: Uint8Array }[] }
  | { type: 'recognize'; image: Uint8Array };
