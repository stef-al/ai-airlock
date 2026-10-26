// Post-build guard: the deliverable must be ONE self-contained, offline HTML file.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const fail = (m) => {
  console.error('check-dist FAILED: ' + m);
  process.exit(1);
};
const files = readdirSync('dist');
if (files.length !== 1 || files[0] !== 'airlock.html') fail('dist must contain only airlock.html, found: ' + files.join(', '));
const html = readFileSync('dist/airlock.html', 'utf8');

const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
if (!csp) fail('Content-Security-Policy meta tag is missing');
for (const need of ["default-src 'none'", "connect-src 'none'", 'worker-src blob:', "base-uri 'none'", "form-action 'none'", "object-src 'none'"]) {
  if (!csp.includes(need)) fail(`CSP lacks ${need}`);
}
if (/unsafe-inline|unsafe-eval|\*|https?:/.test(csp.replace(/'sha256-[^']+'/g, ''))) fail('CSP is not strict: ' + csp);

const hash = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
for (const m of scripts) {
  if (/\bsrc\s*=/.test(m[0].slice(0, m[0].indexOf('>')))) fail('external <script src>');
  if (m[1] && !csp.includes(hash(m[1]))) fail('inline script hash is not in the CSP');
}
for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) if (m[1] && !csp.includes(hash(m[1]))) fail('inline style hash is not in the CSP');

const head = html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '');
for (const m of head.matchAll(/<(link|img|iframe|frame|embed|object|source|video|audio|form|base)\b[^>]*>/gi)) {
  const tag = m[0];
  if (/^<link\b/i.test(tag) && /rel="icon"/.test(tag) && /href="data:/.test(tag)) continue;
  fail('unexpected tag in HTML: ' + tag.slice(0, 80));
}
const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
if (/@import|url\(\s*["']?(?!data:)/i.test(css)) fail('CSS references an external resource');
for (const bad of ['XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'importScripts(', 'fetch(']) {
  if (html.includes(bad)) fail(`bundle contains ${bad}`);
}
console.log(`dist/airlock.html OK: ${(statSync('dist/airlock.html').size / 1024).toFixed(0)} kB, single file, strict CSP, no network primitives`);
