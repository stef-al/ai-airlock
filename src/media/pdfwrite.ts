// A minimal PDF writer for redacted copies: one JPEG per page, drawn over the whole page. Nothing
// else is written: no text, fonts, annotations, outline, attachments, scripts, Info or XMP.

export interface ImagePage {
  /** baseline JPEG (what canvas.toBlob('image/jpeg') makes) */
  jpeg: Uint8Array;
  /** image size in pixels */
  wPx: number;
  hPx: number;
  /** page size in points (1/72 inch), rotation already applied */
  wPt: number;
  hPt: number;
}

const num = (n: number) => String(Math.round(n * 100) / 100);

export function writeImagePdf(pages: ImagePage[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const put = (x: string | Uint8Array) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b);
    size += b.length;
  };
  const obj = (n: number, ...body: (string | Uint8Array)[]) => {
    offsets[n] = size;
    put(`${n} 0 obj\n`);
    body.forEach(put);
    put('\nendobj\n');
  };
  // header; the comment line of high bytes marks the file as binary
  put('%PDF-1.4\n');
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const pageObj = (i: number) => 3 + i * 3;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const n = pageObj(i);
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.wPt)} ${num(p.hPt)}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    const draw = `q ${num(p.wPt)} 0 0 ${num(p.hPt)} 0 0 cm /Im0 Do Q`;
    obj(n + 1, `<< /Length ${enc.encode(draw).length} >>\nstream\n${draw}\nendstream`);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.wPx} /Height ${p.hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream');
  });
  const count = 3 + pages.length * 3;
  const xref = size;
  // every xref entry is exactly 20 bytes
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
