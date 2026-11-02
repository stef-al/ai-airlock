export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.className = 'offscreen';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function downloadText(name: string, text: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Legacy 8-bit code page for files that are not valid UTF-8, by the browser's language. */
function legacyEncoding(): string {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2).toLowerCase();
  return ['cs', 'sk', 'pl', 'hu', 'sl', 'hr', 'ro', 'bs', 'sr'].includes(lang) ? 'windows-1250' : 'windows-1252';
}

export type Input =
  | { ok: true; kind: 'text'; text: string }
  | { ok: true; kind: 'image'; bytes: Uint8Array }
  | { ok: false; reason: string };

const startsWith = (b: Uint8Array, ...sig: number[]) => sig.every((v, i) => b[i] === v);

/** What a file is, by its first bytes: text (any encoding), an image, or something we cannot read yet. */
export async function readInput(file: File, media: boolean): Promise<Input> {
  if (file.size > 25 * 1024 * 1024) return { ok: false, reason: 'larger than 25 MB' };
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4096));
  const image =
    startsWith(head, 0x89, 0x50, 0x4e, 0x47) || startsWith(head, 0xff, 0xd8, 0xff) || startsWith(head, 0x47, 0x49, 0x46, 0x38) || (startsWith(head, 0x52, 0x49, 0x46, 0x46) && startsWith(head.subarray(8), 0x57, 0x45, 0x42, 0x50)) || (startsWith(head, 0x42, 0x4d) && head.length > 26);
  const where = media ? 'is not supported yet (coming in a later version)' : 'needs airlock-media.html (the same app with images and documents)';
  if (image) return media ? { ok: true, kind: 'image', bytes: new Uint8Array(buf) } : { ok: false, reason: 'an image ' + where };
  if (startsWith(head, 0x25, 0x50, 0x44, 0x46)) return { ok: false, reason: 'a PDF ' + where };
  if (startsWith(head, 0x50, 0x4b, 0x03, 0x04)) return { ok: false, reason: 'an Office or ZIP file ' + where };
  // UTF-16 (Windows PowerShell's default for Out-File and redirection) is full of zero bytes
  if (head[0] === 0xff && head[1] === 0xfe) return { ok: true, kind: 'text', text: new TextDecoder('utf-16le').decode(buf) };
  if (head[0] === 0xfe && head[1] === 0xff) return { ok: true, kind: 'text', text: new TextDecoder('utf-16be').decode(buf) };
  if (head.includes(0)) return { ok: false, reason: 'looks like a binary file' };
  try {
    return { ok: true, kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { ok: true, kind: 'text', text: new TextDecoder(legacyEncoding()).decode(buf) };
  }
}

export function downloadBytes(name: string, bytes: Uint8Array, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy an image to the clipboard (PNG is the format every browser accepts there). */
export async function copyImage(png: Uint8Array): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as BlobPart], { type: 'image/png' }) })]);
    return true;
  } catch {
    return false;
  }
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Minimal CSV/TXT term importer for always-mask lists: one term per line, first column wins. */
export function parseTerms(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let cell = t;
    if (t.startsWith('"')) {
      const m = /^"((?:[^"]|"")*)"/.exec(t);
      cell = m ? m[1].replace(/""/g, '"') : t;
    } else cell = t.split(/[;,\t]/)[0].trim();
    if (cell.length >= 2) out.push(cell);
  }
  return [...new Set(out)];
}
