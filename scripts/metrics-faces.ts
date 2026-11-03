// Face metrics: real group photos and composites of a public-domain portrait at known sizes go
// through the face detector of dist/airlock-media.html (#selftest); text screenshots without faces
// count false alarms. The photos are downloaded once into a cache outside the repository (their
// hashes and hand-marked face boxes are in tests/faces/sources.json) and never committed.
//   npm run build && npm run metrics:faces [-- --details --quick]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import type { Box } from '../src/media/ocrTypes';
import { loadFixtures } from '../tests/harness';

const args = process.argv.slice(2);
const details = args.includes('--details');
// tuning knobs passed to the detector (the app uses its defaults)
const num = (k: string) => {
  const v = args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  return v === undefined ? undefined : Number(v);
};
const knobs = { minTile: num('min-tile'), maxTiles: num('max-tiles'), minScore: num('min-score') };
const quick = args.includes('--quick');
const SRC = JSON.parse(readFileSync('tests/faces/sources.json', 'utf8'));
const DATA = join(tmpdir(), 'airlock-faces-data');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function cached(path: string, hash: string, fetch: () => void): Buffer {
  if (!existsSync(path)) fetch();
  const b = readFileSync(path);
  if (sha(b) !== hash) throw new Error(`${path}: unexpected content (hash)`);
  return b;
}

function photos() {
  mkdirSync(DATA, { recursive: true });
  const groups = new Map<string, { bytes: Buffer; faces: Box[] }>();
  for (const [name, f] of Object.entries(SRC.groups.files) as [string, { sha256: string; faces: Box[] }][]) {
    const path = join(DATA, 'package/demo', name);
    const bytes = cached(path, f.sha256, () => {
      const tgz = execFileSync('npm', ['pack', SRC.groups.package, '--silent'], { cwd: DATA, encoding: 'utf8' }).trim().split('\n').pop()!;
      execFileSync('tar', ['-xzf', tgz, ...Object.keys(SRC.groups.files).map((n) => 'package/demo/' + n)], { cwd: DATA });
    });
    groups.set(name, { bytes, faces: f.faces });
  }
  const portrait = cached(join(DATA, 'astronaut.png'), SRC.portrait.sha256, () => {
    execFileSync('curl', ['-sSL', '-o', join(DATA, 'sdist.tgz'), SRC.portrait.sdist]);
    writeFileSync(join(DATA, 'astronaut.png'), execFileSync('tar', ['-xzOf', join(DATA, 'sdist.tgz'), SRC.portrait.member], { maxBuffer: 1 << 26 }));
  });
  return { groups, portrait };
}

/** share of a face box covered by the detected boxes (sampled every 2 px) */
function covered(face: Box, boxes: Box[]): number {
  let n = 0;
  let k = 0;
  for (let y = face[1] + 1; y < face[3]; y += 2) {
    for (let x = face[0] + 1; x < face[2]; x += 2) {
      n++;
      if (boxes.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])) k++;
    }
  }
  return n ? k / n : 0;
}
const inter = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
/** a detection that touches no face */
const isFalse = (d: Box, faces: Box[]) => !faces.some((f) => inter(d, f) >= 0.1 * (f[2] - f[0]) * (f[3] - f[1]));

interface Case {
  set: string;
  html: string;
  width: number;
  height: number;
  faces: Box[];
  jpeg?: boolean;
}

const P = SRC.portrait as { face: Box; crop: Box };
const FACE_H = P.face[3] - P.face[1];
const CROP_W = P.crop[2] - P.crop[0];
const CROP_H = P.crop[3] - P.crop[1];

/** the portrait cropped around the head, placed at (x, y) so that its face is `faceH` px tall */
function head(url: string, x: number, y: number, faceH: number, o: { rotate?: number; gray?: boolean; round?: boolean } = {}): { html: string; face: Box } {
  const k = faceH / FACE_H;
  const w = CROP_W * k;
  const h = CROP_H * k;
  const css = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;overflow:hidden;${o.round ? 'border-radius:50%;' : ''}${o.rotate ? `transform:rotate(${o.rotate}deg);` : ''}${o.gray ? 'filter:grayscale(1);' : ''}`;
  const img = `<img src="${url}" style="position:absolute;left:${-P.crop[0] * k}px;top:${-P.crop[1] * k}px;width:${512 * k}px;height:${512 * k}px">`;
  // the face box, turned with the head around its centre
  const fx0 = x + (P.face[0] - P.crop[0]) * k;
  const fy0 = y + (P.face[1] - P.crop[1]) * k;
  const fx1 = x + (P.face[2] - P.crop[0]) * k;
  const fy1 = y + (P.face[3] - P.crop[1]) * k;
  const a = ((o.rotate ?? 0) * Math.PI) / 180;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const pts = [[fx0, fy0], [fx1, fy0], [fx0, fy1], [fx1, fy1]].map(([px, py]) => [cx + (px - cx) * Math.cos(a) - (py - cy) * Math.sin(a), cy + (px - cx) * Math.sin(a) + (py - cy) * Math.cos(a)]);
  return { html: `<div style="${css}">${img}</div>`, face: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function composites(url: string): Case[] {
  const out: Case[] = [];
  const texts = loadFixtures().map((f) => f.text.split('\n').filter((l) => l.trim()));
  // a room: faces of one size at three places, with variants
  const sizes = quick ? [16, 32, 64, 128] : [12, 16, 20, 24, 32, 48, 64, 96, 160];
  for (const s of sizes) {
    for (const v of quick ? ['plain'] : ['plain', 'gray', 'jpeg50', 'rot+15', 'rot-15']) {
      const parts = [180, 700, 1220].map((x, i) => head(url, x - (CROP_W * s) / FACE_H / 2 + 100, 260 + i * 120, s, { gray: v === 'gray', rotate: v === 'rot+15' ? 15 : v === 'rot-15' ? -15 : 0 }));
      const bg = '<div style="position:absolute;left:0;top:640px;width:1600px;height:360px;background:#5b4b3e"></div><div style="position:absolute;left:1300px;top:80px;width:220px;height:300px;background:#d9d4c7"></div>';
      out.push({ set: `photo ${v}`, width: 1600, height: 1000, jpeg: v === 'jpeg50', faces: parts.map((p) => p.face), html: `<body style="margin:0;background:linear-gradient(#a9a093,#cfc8bb)">${bg}${parts.map((p) => p.html).join('')}</body>` });
    }
  }
  // a chat window with avatars next to messages (round, small)
  for (const a of quick ? [36, 64] : [28, 36, 48, 64]) {
    const rows = texts.slice(0, 6).map((t, i) => ({ y: 30 + i * 120, text: t.slice(0, 3).join('<br>') }));
    const heads = rows.map((r) => head(url, 24, r.y, a * (FACE_H / CROP_H) * 1.0, { round: true }));
    const html = `<body style="margin:0;background:#fff;font:14px Arial">${rows.map((r, i) => `${heads[i].html}<div style="position:absolute;left:${40 + a}px;top:${r.y}px;width:1100px"><b>Person ${i + 1}</b><br>${esc(r.text).replace(/&lt;br&gt;/g, '<br>')}</div>`).join('')}</body>`;
    out.push({ set: 'chat avatars', width: 1280, height: 800, faces: heads.map((h) => h.face), html });
  }
  // a video call: 3 × 3 tiles
  {
    const parts: { html: string; face: Box }[] = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) parts.push(head(url, c * 427 + 120, r * 240 + 10, 90));
    out.push({ set: 'video call', width: 1280, height: 720, faces: parts.map((p) => p.face), html: `<body style="margin:0;background:#202124">${parts.map((p) => p.html).join('')}</body>` });
  }
  // an identity card
  {
    const p = head(url, 30, 60, 70);
    out.push({ set: 'id card', width: 640, height: 400, faces: [p.face], html: `<body style="margin:0;background:#e8eef5;font:16px Arial">${p.html}<div style="position:absolute;left:240px;top:70px;line-height:1.8">IDENTITY CARD<br>Surname: ERIKSEN<br>Given names: ANNA MARIA<br>Date of birth: 14.02.1988<br>No. X4R7T2K9</div></body>` });
  }
  return out;
}

function negatives(): Case[] {
  const styles = quick ? ['font:15px Arial;color:#111;background:#fff'] : ['font:15px Arial;color:#111;background:#fff', 'font:14px Arial;color:#d4d4d4;background:#1e1e1e', "font:14px 'DejaVu Sans Mono',monospace;color:#222;background:#fafafa"];
  return loadFixtures().flatMap((f) => styles.map((css) => ({ set: 'text screenshots', width: 1040, height: 700, faces: [], html: `<body style="margin:0;${css}"><pre style="margin:0;padding:18px;white-space:pre-wrap;word-break:break-all;font:inherit">${esc(f.text.split('\n').slice(0, 40).join('\n'))}</pre></body>` })));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] }).catch(() => chromium.launch({ args: ['--no-sandbox'] }));
const gen = await browser.newPage();
const app = await browser.newPage();
await app.goto('file://' + resolve('dist/airlock-media.html') + '#selftest');
await app.waitForFunction(() => !!(globalThis as never as { __airlockSelfTest?: unknown }).__airlockSelfTest, null, { timeout: 30000 });
type Res = { faces: { box: Box; score: number }[]; backend: string; ms: number };
const detect = (p: Page, b64: string) => p.evaluate(([x, o]) => (globalThis as never as { __airlockSelfTest: { faces(a: string, o: unknown): Promise<Res> } }).__airlockSelfTest.faces(x, o), [b64, knobs] as const);
const tpScores: number[] = [];
const fpScores: number[] = [];

const data = photos();
const portraitUrl = 'data:image/png;base64,' + data.portrait.toString('base64');
const rows = new Map<string, { images: number; faces: number; found: number; fp: number; ms: number }>();
const bySize = new Map<number, [number, number]>();
const lines: string[] = [];
let backend = '';
const record = (set: string, faces: Box[], res: Res, label: string) => {
  backend = res.backend;
  const r = rows.get(set) ?? rows.set(set, { images: 0, faces: 0, found: 0, fp: 0, ms: 0 }).get(set)!;
  r.images++;
  r.ms += res.ms;
  const boxes = res.faces.map((f) => f.box);
  for (const f of faces) {
    r.faces++;
    const c = covered(f, boxes);
    const h = Math.round(f[3] - f[1]);
    const bucket = [12, 16, 20, 24, 32, 48, 64, 96, 160, 10000].find((x) => h <= x * 1.15) ?? 10000;
    const s = bySize.get(bucket) ?? bySize.set(bucket, [0, 0]).get(bucket)!;
    s[1]++;
    if (c >= 0.9) {
      r.found++;
      s[0]++;
      tpScores.push(Math.max(0, ...res.faces.filter((d) => inter(d.box, f) >= 0.5 * (f[2] - f[0]) * (f[3] - f[1])).map((d) => d.score)));
    } else if (details) lines.push(`  MISS ${label} face ${f.map(Math.round).join(',')} (${h} px) covered ${(c * 100).toFixed(0)}%`);
  }
  for (const d of res.faces) {
    if (!isFalse(d.box, faces)) continue;
    r.fp++;
    fpScores.push(d.score);
    if (details) lines.push(`  FALSE ${label} ${d.box.map(Math.round).join(',')} score ${d.score.toFixed(2)}`);
  }
};

for (const [name, g] of data.groups) record('group photos', g.faces, await detect(app, g.bytes.toString('base64')), name);
for (const c of [...composites(portraitUrl), ...negatives()]) {
  await gen.setViewportSize({ width: c.width, height: c.height });
  await gen.setContent(c.html);
  await gen.waitForFunction(() => [...document.images].every((i) => i.complete));
  const shot = await gen.screenshot({ type: c.jpeg ? 'jpeg' : 'png', quality: c.jpeg ? 50 : undefined });
  record(c.set, c.faces, await detect(app, shot.toString('base64')), c.set);
}

// end to end: the image pipeline (OCR, findings, masking, painting) covers a face with a labelled box
{
  const card = composites(portraitUrl).find((c) => c.set === 'id card')!;
  await gen.setViewportSize({ width: card.width, height: card.height });
  await gen.setContent(card.html);
  await gen.waitForFunction(() => [...document.images].every((i) => i.complete));
  const shot = (await gen.screenshot()).toString('base64');
  type Processed = { hits: { type: string }[]; finalBoxes: Box[]; output: string };
  const r = await app.evaluate((x) => (globalThis as never as { __airlockSelfTest: { processImage(a: string): Promise<Processed> } }).__airlockSelfTest.processImage(x), shot);
  const ok = r.hits.some((h) => h.type === 'FACE') && covered(card.faces[0], r.finalBoxes) >= 0.9 && /Face: \[FACE_\d+\]/.test(r.output);
  console.log(`end to end (ID card through the image pipeline): ${ok ? 'face found, covered and labelled' : 'FAILED ' + JSON.stringify(r.hits)}`);
}
console.log(`face detector backend: ${backend}`);
console.log(`${'set'.padEnd(18)} ${'images'.padStart(6)} ${'faces'.padStart(6)} ${'found'.padStart(6)} ${'recall%'.padStart(8)} ${'false'.padStart(6)} ${'ms/img'.padStart(7)}`);
for (const [set, r] of rows) console.log(`${set.padEnd(18)} ${String(r.images).padStart(6)} ${String(r.faces).padStart(6)} ${String(r.found).padStart(6)} ${(r.faces ? ((100 * r.found) / r.faces).toFixed(1) : '-').padStart(8)} ${String(r.fp).padStart(6)} ${String(Math.round(r.ms / r.images)).padStart(7)}`);
console.log('recall by face height (eyebrows to chin): ' + [...bySize.entries()].sort((a, b) => a[0] - b[0]).map(([h, [f, n]]) => `${h === 10000 ? '>160' : '≤' + h} ${f}/${n}`).join(', '));
const hist = (v: number[]) => [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1.01].map((t, i, a) => `${i ? a[i - 1].toFixed(2) + '–' : '<'}${t.toFixed(2)}: ${v.filter((x) => x < t && (i ? x >= a[i - 1] : true)).length}`).join(', ');
console.log(`scores of faces found: ${hist(tpScores)}`);
console.log(`scores of false boxes: ${hist(fpScores)}`);
for (const l of lines) console.log(l);
await browser.close();
