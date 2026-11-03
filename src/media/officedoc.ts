// Office documents in the app: the pure pipeline (office/) plus what needs a browser: deciding
// which pictures can be decoded, rasterising SVG, building the copy from the redacted pictures.
import type { MaskRes } from '../worker/protocol';
import { BLANK_PNG, buildCopy, officeAnalyzeOptions, openOffice, type OfficeFile, type RedactedImage } from './office/office';

export { officeAnalyzeOptions };
export type { OfficeFile };

export interface OfficePicture {
  /** media path in the file (key of the child image document) */
  path: string;
  name: string;
  /** what goes through the image pipeline (an SVG is rasterised) */
  bytes: Uint8Array;
}

export interface OfficeState {
  bytes: Uint8Array;
  file?: OfficeFile;
  pictures: OfficePicture[];
  /** pictures that could not be decoded: a blank takes their place */
  blanks: string[];
}

export const newOfficeState = (bytes: Uint8Array): OfficeState => ({ bytes, pictures: [], blanks: [] });

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

async function decodable(bytes: Uint8Array): Promise<boolean> {
  try {
    (await createImageBitmap(new Blob([bytes as BlobPart]))).close();
    return true;
  } catch {
    return false;
  }
}

/** an SVG drawn as an image (no scripts, no requests) onto white, as a PNG */
async function rasterizeSvg(bytes: Uint8Array): Promise<Uint8Array> {
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + toB64(bytes);
  await img.decode();
  const k = Math.min(1, 2000 / Math.max(img.naturalWidth || 800, img.naturalHeight || 600));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((img.naturalWidth || 800) * k));
  c.height = Math.max(1, Math.round((img.naturalHeight || 600) * k));
  const x = c.getContext('2d')!;
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('the SVG could not be drawn'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Open the file (scrubbed, text read) and prepare its pictures for the image pipeline. */
export async function readOffice(bytes: Uint8Array): Promise<Omit<OfficeState, 'bytes'> & { file: OfficeFile }> {
  const file = openOffice(bytes);
  const pictures: OfficePicture[] = [];
  const blanks: string[] = [];
  for (const m of file.media) {
    const name = m.path.replace(/^.*\//, '');
    try {
      if (/\.svg$/i.test(m.part)) pictures.push({ path: m.path, name, bytes: await rasterizeSvg(m.bytes) });
      else if (await decodable(m.bytes)) pictures.push({ path: m.path, name, bytes: m.bytes });
      else blanks.push(m.path);
    } catch {
      blanks.push(m.path);
    }
  }
  return { file, pictures, blanks };
}

/**
 * The redacted copy: masked text in place, every picture's redacted copy, or a blank for pictures
 * that could not be decoded and pictures the user removed.
 */
export function officeCopy(st: OfficeState, res: MaskRes, images: Map<string, RedactedImage>, removed: string[] = []): Uint8Array {
  if (!st.file) throw new Error('the file is not read yet');
  const all = new Map(images);
  for (const p of [...st.blanks, ...removed]) all.set(p, { bytes: BLANK_PNG, mime: 'image/png', width: 1, height: 1 });
  const reps = res.replacements.map((r) => ({ start: r.start, end: r.end, text: res.output.slice(r.outStart, r.outEnd) }));
  return buildCopy(st.file, reps, all);
}

export const OFFICE_MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
