// Image metrics: the labelled corpus is rendered as screenshots in several styles (secrets are
// generated at test time, nothing is committed), each one goes through dist/airlock-media.html
// (#selftest), and we measure how much of every labelled span the redaction covers and whether a
// labelled value is still readable in the redacted copy.
// With --pdf the corpus becomes PDFs instead: text PDFs (Chromium's print, proportional and
// monospace fonts, several pages) and scanned PDFs (a screenshot as the page). We measure whether
// every occurrence of a labelled value is masked in the document text, and whether it is still
// readable (OCR) in the redacted copy.
//   npm run build && npm run metrics:media [-- --quick] [--style=clean] [--details] [--pdf]
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { findValue, ocrText } from '../src/media/ocrdoc';
import type { Box } from '../src/media/ocrTypes';
import { fixtureSettings, loadFixtures, type Fixture } from '../tests/harness';

const args = process.argv.slice(2);
const details = args.includes('--details');
const pdfMode = args.includes('--pdf');
interface Style {
  css: string;
  jpeg?: number;
  rotate?: number;
  degraded?: boolean;
  /** text: printed to PDF; scan: a screenshot as a PDF page */
  pdf?: 'text' | 'scan';
}
const IMAGE_STYLES: Record<string, Style> = {
  clean: { css: 'font: 15px Arial, sans-serif; color: #111; background: #fff' },
  // single quotes inside: the CSS goes into a double-quoted style attribute
  mono: { css: "font: 14px 'DejaVu Sans Mono', monospace; color: #222; background: #fafafa" },
  dark: { css: 'font: 14px Arial, sans-serif; color: #d4d4d4; background: #1e1e1e', degraded: true },
  small: { css: 'font: 12px Arial, sans-serif; color: #333; background: #fff', degraded: true },
  photo: { css: 'font: 15px Georgia, serif; color: #222; background: #f4f1ea', jpeg: 60, rotate: 1, degraded: true },
};
const PDF_STYLES: Record<string, Style> = {
  pdf: { css: 'font: 12px Arial, sans-serif; color: #111; background: #fff', pdf: 'text' },
  pdfmono: { css: "font: 11px 'DejaVu Sans Mono', monospace; color: #111; background: #fff", pdf: 'text' },
  scan: { css: 'font: 15px Arial, sans-serif; color: #111; background: #fff', pdf: 'scan', degraded: true },
};
const STYLES = pdfMode ? PDF_STYLES : IMAGE_STYLES;
const only = args.find((a) => a.startsWith('--style='))?.slice(8);
const styles = Object.keys(STYLES).filter((s) => (only ? s === only : args.includes('--quick') ? s === Object.keys(STYLES)[0] : true));
const maxLines = (st: Style) => (st.pdf === 'text' ? 120 : 40);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** the first lines of a fixture, with every labelled span wrapped so its boxes can be measured */
function html(f: Fixture, style: string): { body: string; spans: Fixture['spans'] } {
  const st = STYLES[style];
  let end = 0;
  for (let i = 0, n = 0; i < f.text.length; i++) if (f.text[i] === '\n' && ++n === maxLines(st)) end = i;
  if (!end) end = f.text.length;
  const spans = f.spans.filter((s) => s.end <= end);
  let out = '';
  let pos = 0;
  spans.forEach((s, k) => {
    out += esc(f.text.slice(pos, s.start)) + `<span data-e="${k}">${esc(f.text.slice(s.start, s.end))}</span>`;
    pos = s.end;
  });
  out += esc(f.text.slice(pos, end));
  return {
    body: `<body style="margin:0;${st.css}"><pre id="c" style="margin:0;padding:18px;width:${st.pdf === 'text' ? 'auto' : '1000px'};white-space:pre-wrap;word-break:break-all;font:inherit;${st.rotate ? `transform:rotate(${st.rotate}deg);transform-origin:0 0;` : ''}">${out}</pre></body>`,
    spans,
  };
}

async function render(page: Page, f: Fixture, style: string) {
  const { body, spans } = html(f, style);
  await page.setContent(body);
  const rects = await page.evaluate((n) => {
    const out: [number, number, number, number][][] = [];
    for (let k = 0; k < n; k++) {
      const el = document.querySelector(`[data-e="${k}"]`);
      out.push(el ? [...el.getClientRects()].filter((r) => r.width > 1).map((r) => [r.left, r.top, r.right, r.bottom] as [number, number, number, number]) : []);
    }
    return out;
  }, spans.length);
  const st = STYLES[style];
  const shot = await page.screenshot({ fullPage: true, type: st.jpeg ? 'jpeg' : 'png', quality: st.jpeg });
  return { image: shot.toString('base64'), spans, rects };
}

/**
 * fraction of the span's pixels inside the union of the boxes (sampled on a 1 px grid). A CSS line
 * box is taller than the glyphs: its top and bottom 12% (line gap) are not counted.
 */
function coverage(rects: Box[], boxes: Box[]): number {
  let total = 0;
  let inside = 0;
  for (const r of rects) {
    const gap = (r[3] - r[1]) * 0.12;
    for (let y = Math.floor(r[1] + gap) + 0.5; y < r[3] - gap; y++) {
      for (let x = Math.floor(r[0]) + 0.5; x < r[2]; x++) {
        total++;
        if (boxes.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])) inside++;
      }
    }
  }
  return total ? inside / total : 1;
}

interface SelfTest {
  processPdf(a: string, b: unknown): Promise<{ text: string; output: string; pdf: string; ms: number; hits: { start: number; end: number }[]; pageBoxes: Box[][] }>;
  pdfInfo(a: string, render: boolean): Promise<{ pages: { text: string; png: string }[] }>;
  readText(a: string): Promise<string>;
}
const st = (p: Page) => p.evaluate.bind(p) as <R, A>(f: (a: A) => R | Promise<R>, a: A) => Promise<R>;

/** where a labelled value is in a text: fuzzy (findValue) from 4 characters, whole words below */
function occurrences(text: string, value: string): { start: number; end: number }[] {
  if (value.replace(/\s/g, '').length >= 4) return findValue({ text, boxes: [], lines: [] }, value);
  const out: { start: number; end: number }[] = [];
  const lower = text.toLowerCase();
  const v = value.toLowerCase();
  for (let i = lower.indexOf(v); i >= 0 && v; i = lower.indexOf(v, i + 1)) if (!/[\p{L}\d]/u.test(text[i - 1] ?? ' ') && !/[\p{L}\d]/u.test(text[i + v.length] ?? ' ')) out.push({ start: i, end: i + v.length });
  return out;
}

async function pdfDoc(f: Fixture, style: string): Promise<{ pdf: Buffer; spans: Fixture['spans']; rects?: Box[][] }> {
  const s = STYLES[style];
  if (s.pdf === 'text') {
    const { body, spans } = html(f, style);
    await gen.setContent(body);
    return { pdf: await gen.pdf({ format: 'A4', margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } }), spans };
  }
  const r = await render(gen, f, style);
  await gen.setContent(`<body style="margin:0"><img src="data:image/png;base64,${r.image}" style="width:100%"></body>`);
  // the screenshot spans the page width (A4: 595.3 pt): span rectangles in page points
  const k = 595.28 / (await gen.evaluate(() => (document.querySelector('img') as HTMLImageElement).naturalWidth));
  return { pdf: await gen.pdf({ format: 'A4' }), spans: r.spans, rects: r.rects.map((rs) => rs.map((b) => b.map((v) => v * k) as Box)) };
}

async function pdfMetrics() {
  console.log(`${'style'.padEnd(8)} ${'docs'.padStart(6)} ${'pages'.padStart(6)} ${'spans'.padStart(6)} ${'found'.padStart(6)} ${'recall%'.padStart(8)} ${'leaks'.padStart(6)} ${'s/page'.padStart(7)}`);
  for (const style of styles) {
    let spans = 0;
    let found = 0;
    let leaks = 0;
    let ms = 0;
    let docs = 0;
    let pages = 0;
    for (const f of fixtures) {
      const { pdf, spans: labelled, rects } = await pdfDoc(f, style);
      if (!labelled.length) continue;
      docs++;
      const res = await st(app)(([b, s]) => (globalThis as never as { __airlockSelfTest: SelfTest }).__airlockSelfTest.processPdf(b, s), [pdf.toString('base64'), fixtureSettings(f)] as const);
      ms += res.ms;
      const info = await st(app)((b) => (globalThis as never as { __airlockSelfTest: SelfTest }).__airlockSelfTest.pdfInfo(b, true), res.pdf);
      pages += info.pages.length;
      if (info.pages.some((p) => p.text)) rows.push(`  TEXT LAYER in the copy: ${style} ${f.id}`);
      let copyText = '';
      for (const p of info.pages) copyText += (await st(app)((b) => (globalThis as never as { __airlockSelfTest: SelfTest }).__airlockSelfTest.readText(b), p.png)) + '\n';
      const copy = ocrText({ text: copyText, conf: 0, words: copyText.split('\n').flatMap((l, ln) => l.split(' ').filter(Boolean).map((w) => ({ text: w, conf: 0, box: [0, 0, 0, 0] as Box, line: ln, chars: [] }))) });
      labelled.forEach((s, k) => {
        spans++;
        // a scan: the span's pixels must be covered, as for screenshots (OCR text cannot be matched exactly)
        if (rects) {
          const c = coverage(rects[k], res.pageBoxes[0] ?? []);
          if (c >= 0.98) found++;
          else if (details) rows.push(`  MISS ${style} ${f.id} ${s.type} ${JSON.stringify(s.text.slice(0, 50))} covered ${(c * 100).toFixed(0)}%`);
          if (s.text.replace(/\s/g, '').length >= 4 && findValue(copy, s.text).length) {
            leaks++;
            rows.push(`  LEAK ${style} ${f.id} ${s.type} ${JSON.stringify(s.text.slice(0, 50))}`);
          }
          return;
        }
        // every occurrence of the value in the document text is (almost) entirely inside findings
        const occ = occurrences(res.text, s.text);
        const covered = (o: { start: number; end: number }) => {
          let n = 0;
          let k = 0;
          for (let i = o.start; i < o.end; i++) {
            if (/\s/.test(res.text[i])) continue;
            n++;
            if (res.hits.some((h) => h.start <= i && i < h.end)) k++;
          }
          return n === 0 || k / n >= 0.98;
        };
        if (occ.length && occ.every(covered)) found++;
        else if (details) rows.push(`  MISS ${style} ${f.id} ${s.type} ${JSON.stringify(s.text.slice(0, 50))}${occ.length ? '' : ' (not in the text read)'}`);
        if (s.text.replace(/\s/g, '').length >= 4 && findValue(copy, s.text).length) {
          leaks++;
          rows.push(`  LEAK ${style} ${f.id} ${s.type} ${JSON.stringify(s.text.slice(0, 50))}`);
        }
      });
    }
    const recall = (100 * found) / Math.max(1, spans);
    console.log(`${style.padEnd(8)} ${fmt(docs, 6)} ${fmt(pages, 6)} ${fmt(spans, 6)} ${fmt(found, 6)} ${recall.toFixed(1).padStart(8)} ${fmt(leaks, 6)} ${(ms / 1000 / Math.max(1, pages)).toFixed(1).padStart(7)}`);
    if (recall < (STYLES[style].degraded ? 90 : 95) || leaks) failed = true;
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] }).catch(() => chromium.launch({ args: ['--no-sandbox'] }));
const gen = await browser.newPage({ viewport: { width: 1040, height: 400 } });
const app = await browser.newPage();
const errors: string[] = [];
app.on('pageerror', (e) => errors.push(e.message));
await app.goto('file://' + resolve('dist/airlock-media.html') + '#selftest');
await app.waitForFunction(() => !!(globalThis as never as { __airlockSelfTest?: unknown }).__airlockSelfTest, null, { timeout: 30000 });

const fixtures = loadFixtures();
const rows: string[] = [];
const fmt = (n: number, w: number) => String(n).padStart(w);
let failed = false;
if (pdfMode) await pdfMetrics();
else console.log(`${'style'.padEnd(8)} ${'images'.padStart(6)} ${'spans'.padStart(6)} ${'found'.padStart(6)} ${'recall%'.padStart(8)} ${'leaks'.padStart(6)} ${'ms/img'.padStart(7)}`);
for (const style of pdfMode ? [] : styles) {
  let spans = 0;
  let found = 0;
  let leaks = 0;
  let ms = 0;
  let images = 0;
  for (const f of fixtures) {
    const r = await render(gen, f, style);
    if (!r.spans.length) continue;
    images++;
    const res = await app.evaluate(([img, s]) => (globalThis as never as { __airlockSelfTest: { processImage(a: string, b: unknown): Promise<{ finalBoxes: Box[]; image: string; ms: number; text: string }> } }).__airlockSelfTest.processImage(img, s), [r.image, fixtureSettings(f)] as const);
    ms += res.ms;
    const again = await app.evaluate((img) => (globalThis as never as { __airlockSelfTest: { readText(a: string): Promise<string> } }).__airlockSelfTest.readText(img), res.image);
    const t = ocrText({ text: again, conf: 0, words: again.split('\n').flatMap((l, ln) => l.split(' ').filter(Boolean).map((w) => ({ text: w, conf: 0, box: [0, 0, 0, 0] as Box, line: ln, chars: [] }))) });
    r.spans.forEach((s, k) => {
      spans++;
      const c = coverage(r.rects[k], res.finalBoxes);
      if (c >= 0.98) found++;
      else if (details) rows.push(`  MISS ${style} ${f.id} ${s.type} ${JSON.stringify(s.text.slice(0, 50))} covered ${(c * 100).toFixed(0)}%`);
      // a labelled value still readable in the redacted copy (4+ characters, one misread allowed for 8+)
      if (s.text.replace(/\s/g, '').length >= 4 && findValue(t, s.text).length) {
        leaks++;
        rows.push(`  LEAK ${style} ${f.id} ${s.type} ${JSON.stringify(s.text.slice(0, 50))}`);
      }
    });
  }
  const recall = (100 * found) / Math.max(1, spans);
  console.log(`${style.padEnd(8)} ${fmt(images, 6)} ${fmt(spans, 6)} ${fmt(found, 6)} ${recall.toFixed(1).padStart(8)} ${fmt(leaks, 6)} ${fmt(Math.round(ms / Math.max(1, images)), 7)}`);
  if (recall < (STYLES[style].degraded ? 85 : 95) || leaks) failed = true;
}
for (const r of rows) console.log(r);
if (errors.length) console.log('page errors:', errors.slice(0, 3));
console.log(
  pdfMode
    ? `targets (text PDFs recall ≥ 95%, scanned ≥ 90%, no readable labelled value): ${failed ? 'MISSED' : 'MET'}`
    : `targets (clean/mono recall ≥ 95%, degraded ≥ 85%, no readable labelled value): ${failed ? 'MISSED' : 'MET'}`,
);
await browser.close();
if (args.includes('--strict') && failed) process.exit(1);
