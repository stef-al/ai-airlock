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

export async function readFileText(file: File): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (file.size > 25 * 1024 * 1024) return { ok: false, reason: 'larger than 25 MB' };
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4096));
  // UTF-16 (Windows PowerShell's default for Out-File and redirection) is full of zero bytes
  if (head[0] === 0xff && head[1] === 0xfe) return { ok: true, text: new TextDecoder('utf-16le').decode(buf) };
  if (head[0] === 0xfe && head[1] === 0xff) return { ok: true, text: new TextDecoder('utf-16be').decode(buf) };
  if (head.includes(0)) return { ok: false, reason: 'looks like a binary file (Office/PDF input is on the roadmap)' };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { ok: true, text: new TextDecoder(legacyEncoding()).decode(buf) };
  }
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
