// What an image file carries besides its pixels. Redaction re-encodes the pixels, so none of this
// survives; the report lists what was dropped. Pure: no DOM.

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp';

export function imageFormat(b: Uint8Array): ImageFormat | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}

export interface ImageMeta {
  format: ImageFormat | null;
  /** human-readable list of metadata found (all of it is dropped by re-encoding) */
  found: string[];
  /** animation frames (only the first is kept) */
  frames: number;
}

const ascii = (b: Uint8Array, s: number, n: number) => String.fromCharCode(...b.subarray(s, Math.min(b.length, s + n)));
const clean = (s: string) => s.replace(/\0+$/, '').trim();

/** The interesting EXIF fields (a TIFF structure: IFD0, the Exif sub-IFD and the GPS IFD). */
function exif(b: Uint8Array, base: number, out: string[]): void {
  const le = b[base] === 0x49;
  const u16 = (o: number) => (le ? b[base + o] | (b[base + o + 1] << 8) : (b[base + o] << 8) | b[base + o + 1]);
  const u32 = (o: number) => (le ? (b[base + o] | (b[base + o + 1] << 8) | (b[base + o + 2] << 16)) + b[base + o + 3] * 0x1000000 : b[base + o] * 0x1000000 + ((b[base + o + 1] << 16) | (b[base + o + 2] << 8) | b[base + o + 3]));
  const NAMES: Record<number, string> = { 0x010f: 'camera make', 0x0110: 'camera model', 0x0131: 'software', 0x013b: 'author', 0x8298: 'copyright', 0x9003: 'date taken', 0xa430: 'camera owner', 0xa431: 'camera serial number', 0xa435: 'lens serial number', 0x9286: 'user comment', 0x010e: 'description' };
  const seen = new Set<number>();
  const ifd = (off: number, depth: number) => {
    if (depth > 3 || off <= 0 || base + off + 2 > b.length || seen.has(off)) return;
    seen.add(off);
    const n = u16(off);
    for (let i = 0; i < n && i < 200; i++) {
      const e = off + 2 + i * 12;
      if (base + e + 12 > b.length) return;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (tag === 0x8825) out.push('EXIF: GPS location');
      else if (tag === 0x8769) ifd(u32(e + 8), depth + 1);
      else if (NAMES[tag]) {
        const val = type === 2 ? clean(ascii(b, count <= 4 ? base + e + 8 : base + u32(e + 8), Math.min(count, 64))) : '';
        out.push(`EXIF: ${NAMES[tag]}${val ? ` (${val})` : ''}`);
      }
    }
  };
  if (u16(2) === 42) ifd(u32(4), 0);
}

export function describeImage(b: Uint8Array): ImageMeta {
  const format = imageFormat(b);
  const found: string[] = [];
  let frames = 1;
  if (format === 'jpeg') {
    let p = 2;
    while (p + 4 <= b.length && b[p] === 0xff) {
      const marker = b[p + 1];
      if (marker === 0xda || marker === 0xd9) break; // image data follows
      const len = (b[p + 2] << 8) | b[p + 3];
      const s = p + 4;
      if (marker === 0xe1 && ascii(b, s, 6) === 'Exif\0\0') exif(b, s + 6, found);
      else if (marker === 0xe1 && ascii(b, s, 28).startsWith('http://ns.adobe.com/xap')) found.push('XMP metadata');
      else if (marker === 0xed) found.push('IPTC / Photoshop metadata');
      else if (marker === 0xfe) found.push(`comment (${clean(ascii(b, s, Math.min(len - 2, 60)))})`);
      p += 2 + len;
    }
  } else if (format === 'png') {
    let p = 8;
    while (p + 8 <= b.length) {
      const len = ((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
      const type = ascii(b, p + 4, 4);
      if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') found.push(`PNG text: ${clean(ascii(b, p + 8, Math.min(len, 79)).split('\0')[0])}`);
      else if (type === 'eXIf') exif(b, p + 8, found);
      else if (type === 'acTL') frames = (b[p + 8] << 24) + ((b[p + 9] << 16) | (b[p + 10] << 8) | b[p + 11]);
      else if (type === 'IEND') break;
      p += 12 + len;
    }
  } else if (format === 'webp') {
    let p = 12;
    let anmf = 0;
    while (p + 8 <= b.length) {
      const type = ascii(b, p, 4);
      const len = (b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16)) + b[p + 7] * 0x1000000;
      if (type === 'EXIF') exif(b, p + 8 + (ascii(b, p + 8, 6) === 'Exif\0\0' ? 6 : 0), found);
      else if (type === 'XMP ') found.push('XMP metadata');
      else if (type === 'ANMF') anmf++;
      p += 8 + len + (len & 1);
    }
    frames = Math.max(1, anmf);
  } else if (format === 'gif') {
    // header, logical screen descriptor and global colour table, then extension and image blocks
    let p = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
    let images = 0;
    const skipSub = (q: number) => {
      while (q < b.length && b[q] !== 0) q += b[q] + 1;
      return q + 1;
    };
    while (p < b.length && b[p] !== 0x3b) {
      if (b[p] === 0x21) {
        if (b[p + 1] === 0xfe) found.push('GIF comment');
        p = skipSub(p + 2);
      } else if (b[p] === 0x2c) {
        images++;
        const flags = b[p + 9];
        p += 10 + (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
        p = skipSub(p + 1);
      } else break;
    }
    frames = Math.max(1, images);
  }
  return { format, found: [...new Set(found)], frames };
}
