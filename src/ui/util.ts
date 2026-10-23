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

export async function readFileText(file: File): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (file.size > 25 * 1024 * 1024) return { ok: false, reason: 'larger than 25 MB' };
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4096));
  if (head.includes(0)) return { ok: false, reason: 'looks like a binary file (Office/PDF input is on the roadmap)' };
  return { ok: true, text: new TextDecoder('utf-8').decode(buf) };
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
