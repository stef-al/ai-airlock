// Post-build guard: each deliverable must be ONE self-contained, offline HTML file.
//   dist/airlock.html        text only
//   dist/airlock-media.html  adds images and documents (WebAssembly, embedded binary assets)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const fail = (m) => {
  console.error('check-dist FAILED: ' + m);
  process.exit(1);
};
const FILES = { 'airlock.html': { media: false, maxMB: 1.5 }, 'airlock-media.html': { media: true, maxMB: 35 } };
const found = readdirSync('dist').sort();
if (found.join() !== Object.keys(FILES).sort().join()) fail('dist must contain exactly ' + Object.keys(FILES).join(', ') + '; found: ' + found.join(', '));

const hash = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

for (const [name, { media, maxMB }] of Object.entries(FILES)) {
  const path = 'dist/' + name;
  const html = readFileSync(path, 'utf8');
  const bad = (m) => fail(`${name}: ${m}`);

  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  if (!csp) bad('Content-Security-Policy meta tag is missing');
  for (const need of ["default-src 'none'", "connect-src 'none'", 'worker-src blob:', "base-uri 'none'", "form-action 'none'", "object-src 'none'"]) {
    if (!csp.includes(need)) bad(`CSP lacks ${need}`);
  }
  // only hashes, plus WebAssembly compilation in the media file; never JS eval, inline or hosts
  let rest = csp.replace(/'sha256-[^']+'/g, '');
  if (media) {
    if (!/script-src [^;]*'wasm-unsafe-eval'/.test(csp)) bad("CSP lacks 'wasm-unsafe-eval' in script-src");
    rest = rest.replace(" 'wasm-unsafe-eval'", '');
  }
  if (/unsafe-|\*|https?:/.test(rest)) bad('CSP is not strict: ' + csp);
  for (const d of rest.split(';')) {
    const [dir, ...vals] = d.trim().split(/\s+/);
    if (['default-src', 'script-src', 'style-src', 'connect-src', 'font-src'].includes(dir) && vals.some((v) => /^(?:blob|data):/.test(v))) bad(`CSP allows ${vals.join(' ')} in ${dir}`);
  }

  // executable scripts must be hashed; inert data blocks (media only) must hold nothing but base64
  let dataBytes = 0;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const [, attrs, body] = m;
    if (/\bsrc\s*=/.test(attrs)) bad('external <script src>');
    if (/type="application\/octet-stream"/.test(attrs)) {
      if (!media) bad('data block in the text-only file');
      if (!/\bid="asset:[\w./-]+"/.test(attrs)) bad('data block without an asset id');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) bad('data block is not plain base64');
      dataBytes += body.length;
      continue;
    }
    if (/\btype=/.test(attrs) && !/type="module"/.test(attrs)) bad('script with unexpected type: ' + attrs.trim());
    if (body && !csp.includes(hash(body))) bad('inline script hash is not in the CSP');
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) if (m[1] && !csp.includes(hash(m[1]))) bad('inline style hash is not in the CSP');

  const head = html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '');
  for (const m of head.matchAll(/<(link|img|iframe|frame|embed|object|source|video|audio|form|base)\b[^>]*>/gi)) {
    const tag = m[0];
    if (/^<link\b/i.test(tag) && /rel="icon"/.test(tag) && /href="data:/.test(tag)) continue;
    bad('unexpected tag in HTML: ' + tag.slice(0, 80));
  }
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  if (/@import|url\(\s*["']?(?!data:)/i.test(css)) bad('CSS references an external resource');

  // The text-only file is scanned whole. The media file bundles pdf.js, Tesseract and TF.js, whose
  // dead URL-loading paths name fetch/XMLHttpRequest: there the build scans our own modules
  // (vite.config.ts) and the media smoke test proves that no request is ever made.
  if (!media) {
    for (const word of ['XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'importScripts(', 'fetch(']) {
      if (html.includes(word)) bad(`bundle contains ${word}`);
    }
  }
  const mb = statSync(path).size / 1048576;
  if (mb > maxMB) bad(`${mb.toFixed(1)} MB exceeds the ${maxMB} MB budget`);
  console.log(`${path} OK: ${mb.toFixed(1)} MB${media ? ` (${(dataBytes / 1048576).toFixed(1)} MB embedded assets)` : ''}, single file, strict CSP${media ? " + 'wasm-unsafe-eval'" : ', no network primitives'}`);
}
