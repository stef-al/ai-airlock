// Office metrics in Node (no browser): every fixture becomes a DOCX (paragraphs whose text is split
// over several formatted runs; CSV as a Word table), a PPTX (ten lines per slide) and an XLSX
// (CSV as a sheet, other text one line per cell), goes through the Office pipeline with the real
// engine, and we measure:
//   recall: every occurrence of a labelled value in the document text is ≥ 98% inside findings
//   leaks:  a labelled value still present anywhere in the copy's XML (text or attribute values)
//   broken: an XML part of the copy that is not well formed
//   npm run metrics:office [-- --details --kind=docx|pptx|xlsx --soffice]
// DOCX and PPTX text is sniffed (code pasted in a document is read as code), XLSX is read as
// Markdown tables, as in the app (officeAnalyzeOptions).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { analyze, buildDoc, Mapping, mask } from '../src/engine';
import { parseCsv, sniffDelimiter } from '../src/engine/segment/csv';
import { findValue } from '../src/media/ocrdoc';
import { buildCopy, officeAnalyzeOptions, openOffice } from '../src/media/office/office';
import { decode, tags } from '../src/media/office/xml';
import { fixtureSettings, loadFixtures, type Fixture } from '../tests/harness';
import { makeDocx, makePptx, makeXlsx, para, table } from '../tests/office-make';

const args = process.argv.slice(2);
const details = args.includes('--details');
const kinds = (args.find((a) => a.startsWith('--kind='))?.slice(7).split(',') ?? ['docx', 'pptx', 'xlsx']) as ('docx' | 'pptx' | 'xlsx')[];

/** deterministic run splits */
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const split = (line: string): string[] => {
  if (line.length < 6) return [line];
  const cuts = [...new Set([Math.floor(rnd() * line.length), Math.floor(rnd() * line.length)])].filter((c) => c > 0 && c < line.length).sort((a, b) => a - b);
  const out: string[] = [];
  let pos = 0;
  for (const c of cuts) {
    out.push(line.slice(pos, c));
    pos = c;
  }
  out.push(line.slice(pos));
  return out;
};

function csvRows(f: Fixture): string[][] | null {
  if (!/\.(?:csv|tsv)$/i.test(f.fileName ?? '')) return null;
  const d = sniffDelimiter(f.text);
  if (!d) return null;
  return parseCsv(f.text, d).map((r) => r.map((c) => f.text.slice(c.start, c.end).replace(/""/g, '"')));
}

function make(f: Fixture, kind: 'docx' | 'pptx' | 'xlsx'): Uint8Array {
  const lines = f.text.split('\n');
  const rows = csvRows(f);
  if (kind === 'docx') return makeDocx({ body: rows ? table(rows) : lines.map((l) => para(split(l))).join('') });
  if (kind === 'pptx') {
    const slides: { lines: string[][] }[] = [];
    for (let i = 0; i < lines.length; i += 10) slides.push({ lines: lines.slice(i, i + 10).map(split) });
    return makePptx(slides);
  }
  const num = (v: string) => (/^-?\d{1,15}(?:\.\d+)?$/.test(v) && !/^0\d/.test(v) ? Number(v) : v);
  return makeXlsx([{ name: 'Data', rows: rows ? rows.map((r) => r.map(num)) : [['Text'], ...lines.map((l) => [l])] }]);
}

/** every text node and attribute value of every XML part, decoded */
function contents(bytes: Uint8Array): { text: string; broken: string[] } {
  const parts: string[] = [];
  const broken: string[] = [];
  for (const [n, b] of Object.entries(unzipSync(bytes))) {
    if (!/\.(?:xml|rels)$/i.test(n)) continue;
    const x = new TextDecoder().decode(b);
    const stack: string[] = [];
    let ok = true;
    for (const t of tags(x)) {
      if (t.self) continue;
      if (!t.close) stack.push(t.name);
      else if (stack.pop() !== t.name) ok = false;
    }
    if (!ok || stack.length) broken.push(n);
    parts.push(decode(x.replace(/<[^>]*>/g, '')), ...[...x.matchAll(/="([^"]*)"/g)].map((m) => decode(m[1])));
  }
  return { text: parts.join('\n'), broken };
}

const out = mkdtempSync(join(tmpdir(), 'office-metrics-'));
const rows: string[] = [];
let failed = false;
console.log(`${'kind'.padEnd(6)} ${'files'.padStart(6)} ${'spans'.padStart(6)} ${'found'.padStart(6)} ${'recall%'.padStart(8)} ${'leaks'.padStart(6)} ${'broken'.padStart(7)} ${'ms/file'.padStart(8)}`);
for (const kind of kinds) {
  let files = 0;
  let spans = 0;
  let found = 0;
  let leaks = 0;
  let broken = 0;
  let ms = 0;
  let tabSpans = 0;
  let tabFound = 0;
  for (const f of loadFixtures()) {
    if (!f.spans.length) continue;
    files++;
    const tabular = !!csvRows(f);
    const s = fixtureSettings(f);
    const t0 = performance.now();
    const file = openOffice(make(f, kind));
    const text = file.text.text;
    // as in the app: detection on the text (as Markdown, or sniffed), masking as plain text
    const a = analyze(text, s, officeAnalyzeOptions(file.kind));
    const m = mask(buildDoc(text, { format: 'prose' }), a.hits, new Mapping(), s);
    const copy = buildCopy(file, m.replacements.map((r) => ({ start: r.start, end: r.end, text: m.output.slice(r.outStart, r.outEnd) })), new Map());
    ms += performance.now() - t0;
    writeFileSync(join(out, `${f.id}-${kind}.${kind}`), copy);
    const c = contents(copy);
    if (c.broken.length) {
      broken++;
      rows.push(`  BROKEN ${kind} ${f.id}: ${c.broken.join(', ')}`);
    }
    const masked = m.replacements.map((r) => [r.start, r.end] as const);
    for (const sp of f.spans) {
      spans++;
      const occ = sp.text.replace(/\s/g, '').length >= 4 ? findValue({ text, boxes: [], lines: [] }, sp.text) : [...text.matchAll(new RegExp(`(?<![\\p{L}\\d])${sp.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'gu'))].map((x) => ({ start: x.index!, end: x.index! + sp.text.length }));
      const covered = (o: { start: number; end: number }) => {
        let n = 0;
        let k = 0;
        for (let i = o.start; i < o.end; i++) {
          if (/\s/.test(text[i])) continue;
          n++;
          if (masked.some(([a2, b2]) => a2 <= i && i < b2)) k++;
        }
        return n === 0 || k / n >= 0.98;
      };
      if (tabular) tabSpans++;
      if (occ.length && occ.every(covered)) {
        found++;
        if (tabular) tabFound++;
      }
      else if (details) rows.push(`  MISS ${kind} ${f.id} ${sp.type} ${JSON.stringify(sp.text.slice(0, 50))}${occ.length ? '' : ' (not in the text read)'}`);
      if (sp.text.trim().length >= 4 && c.text.includes(sp.text.trim())) {
        leaks++;
        if (details || !occ.length || occ.every(covered)) rows.push(`  LEAK ${kind} ${f.id} ${sp.type} ${JSON.stringify(sp.text.slice(0, 50))}`);
      }
    }
  }
  const recall = (100 * found) / Math.max(1, spans);
  console.log(`${kind.padEnd(6)} ${String(files).padStart(6)} ${String(spans).padStart(6)} ${String(found).padStart(6)} ${recall.toFixed(1).padStart(8)} ${String(leaks).padStart(6)} ${String(broken).padStart(7)} ${(ms / Math.max(1, files)).toFixed(0).padStart(8)}${kind === 'xlsx' ? `   (CSV fixtures as sheets: ${tabFound}/${tabSpans})` : ''}`);
  // a spreadsheet of code or chat lines (one line per cell) is not realistic: only tables count for XLSX
  if ((kind === 'xlsx' ? tabFound / Math.max(1, tabSpans) : recall / 100) < 0.95 || broken) failed = true;
}
for (const r of rows) console.log(r);

// LibreOffice opens every copy (optional: needs soffice)
if (args.includes('--soffice')) {
  const pdf = join(out, 'pdf');
  mkdirSync(pdf);
  const all = readdirSync(out).filter((n) => /\.(?:docx|pptx|xlsx)$/.test(n));
  try {
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', pdf, ...all.map((n) => join(out, n))], { stdio: 'ignore', timeout: 900_000 });
  } catch {
    /* reported below */
  }
  const made = new Set(readdirSync(pdf).filter((n) => statSync(join(pdf, n)).size > 0).map((n) => n.replace(/\.pdf$/, '')));
  const missing = all.filter((n) => !made.has(n.replace(/\.\w+$/, '')) && !made.has(n));
  console.log(`LibreOffice converted ${all.length - missing.length}/${all.length} copies to PDF${missing.length ? ': failed ' + missing.join(', ') : ''}`);
  if (missing.length) failed = true;
}
console.log(`targets (recall ≥ 95% per kind, no broken XML; leaks are detection misses): ${failed ? 'MISSED' : 'MET'}`);
if (args.includes('--strict') && failed) process.exit(1);
