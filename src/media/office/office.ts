// Office documents (DOCX, PPTX, XLSX): open → scrub → text with runs → (detection and masking
// elsewhere) → a copy with the masked text written back into the XML, pictures replaced by their
// redacted copies. Pure: runs in Node; pictures are redacted by the caller (media pipeline).
import { Pkg, type OfficeKind } from './package';
import { scrub, type ScrubReport } from './scrub';
import { docxText, TextBuilder, type OfficeText, type Run } from './text';
import { pptxText } from './text-pptx';
import { xlsxText } from './text-xlsx';
import { decode, encode, splice, type Splice } from './xml';

export type { OfficeKind } from './package';
export type { ScrubReport } from './scrub';
export type { OfficeText, Run } from './text';

export interface MediaRef {
  /** unique key: the part, prefixed by the embedded file it is in ("word/embeddings/x.xlsx>xl/media/image1.png") */
  path: string;
  pkg: string;
  part: string;
  bytes: Uint8Array;
}

export interface OfficeFile {
  kind: OfficeKind;
  pkg: Pkg;
  main: string;
  report: ScrubReport;
  /** Office files embedded in this one (charts' workbooks, embedded documents), by part */
  embedded: Map<string, OfficeFile>;
  /** pictures to redact, this file's and its embedded files' */
  media: MediaRef[];
  text: OfficeText;
}

const IMAGE = /\.(png|jpe?g|gif|bmp|webp|tiff?|svg)$/i;
const PACKAGE = /\.(docx|docm|dotx|xlsx|xlsm|xltx|pptx|pptm|potx)$/i;
export const BLANK_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));

export const officeKindOf = (bytes: Uint8Array): OfficeKind | null => {
  try {
    return Pkg.read(bytes).main()?.kind ?? null;
  } catch {
    return null;
  }
};

function textOf(kind: OfficeKind, p: Pkg, main: string, pkg: string): OfficeText {
  return kind === 'docx' ? docxText(p, main, pkg) : kind === 'pptx' ? pptxText(p, main, pkg) : xlsxText(p, main, pkg);
}

/** Open, scrub and read an Office file; embedded Office files are opened too (one level). */
export function openOffice(bytes: Uint8Array, prefix = ''): OfficeFile {
  const pkg = Pkg.read(bytes);
  const m = pkg.main();
  if (!m) throw new Error('not a Word, PowerPoint or Excel file');
  const report = scrub(pkg, m.kind);
  const embedded = new Map<string, OfficeFile>();
  const media: MediaRef[] = [];
  for (const n of pkg.names()) {
    if (PACKAGE.test(n) && /\/embeddings\//.test(n)) {
      // one level deep; files embedded in embedded files are blanked
      try {
        if (prefix) throw new Error('too deep');
        embedded.set(n, openOffice(pkg.bytes(n)!, n));
      } catch {
        pkg.setBytes(n, new Uint8Array());
        report.blanked.push(n);
      }
    } else if (IMAGE.test(n) && /\/media\//.test(n)) {
      if (/\.tiff?$/i.test(n)) {
        // browsers cannot decode TIFF: a blank picture takes its place
        const to = n.replace(/\.tiff?$/i, '.png');
        pkg.renamePart(n, to, 'image/png');
        pkg.setBytes(to, BLANK_PNG);
        report.blanked.push(n);
        continue;
      }
      media.push({ path: prefix ? `${prefix}>${n}` : n, pkg: prefix, part: n, bytes: pkg.bytes(n)! });
    }
  }
  const own = textOf(m.kind, pkg, m.part, prefix);
  const b = new TextBuilder(prefix);
  b.append('', own);
  for (const [part, child] of embedded) {
    b.append(`Embedded file ${part.slice(part.lastIndexOf('/') + 1)}`, child.text);
    media.push(...child.media);
  }
  return { kind: m.kind, pkg, main: m.part, report, embedded, media, text: b.done() };
}

/**
 * How the engine reads an Office text: a document or a deck is sniffed (code pasted into it is
 * read as code; tables make it Markdown), a workbook is Markdown tables.
 */
export const officeAnalyzeOptions = (kind: OfficeKind): { fileName?: string } => (kind === 'xlsx' ? { fileName: 'workbook.md' } : {});

export interface Replacement {
  start: number;
  end: number;
  /** what goes in its place (placeholder, fake or redaction) */
  text: string;
}

/** the runs a span of the document text touches (runs are sorted by position) */
function touched(runs: Run[], start: number, end: number): Run[] {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].at + runs[mid].len <= start) lo = mid + 1;
    else hi = mid;
  }
  const out: Run[] = [];
  for (let i = lo; i < runs.length && runs[i].at < end; i++) out.push(runs[i]);
  return out;
}

/**
 * The XML edits for a set of replacements: the placeholder goes into the first run a finding
 * touches, the rest of the finding is removed from the other runs (a value split across runs or
 * paragraphs is replaced as a whole).
 */
export function runEdits(f: OfficeFile, reps: Replacement[]): Map<string, Map<string, Splice[]>> {
  // runs at one place in the XML (a shared string shown in several cells) get the union of their edits
  const local = new Map<string, { run: Run; edits: { a: number; b: number; text: string }[] }>();
  for (const r of [...reps].sort((x, y) => x.start - y.start)) {
    touched(f.text.runs, r.start, r.end).forEach((run, i) => {
      const key = `${run.pkg}\u0000${run.part}\u0000${run.s}`;
      const entry = local.get(key) ?? local.set(key, { run, edits: [] }).get(key)!;
      entry.edits.push({ a: Math.max(r.start, run.at) - run.at, b: Math.min(r.end, run.at + run.len) - run.at, text: i === 0 ? r.text : '' });
    });
  }
  const out = new Map<string, Map<string, Splice[]>>();
  const xmlOf = (run: Run) => (run.pkg ? f.embedded.get(run.pkg)!.pkg : f.pkg).xml(run.part);
  for (const { run, edits } of local.values()) {
    const x = xmlOf(run);
    const old = run.shown ?? decode(x.slice(run.s, run.e));
    let text = '';
    let pos = 0;
    // the earlier edit first, the longer one of two that start together; overlapping ones are dropped
    for (const e of edits.sort((p, q) => p.a - q.a || q.b - p.b)) {
      if (e.a < pos) continue;
      text += old.slice(pos, e.a) + e.text;
      pos = e.b;
    }
    text += old.slice(pos);
    const parts = out.get(run.pkg) ?? out.set(run.pkg, new Map()).get(run.pkg)!;
    const list = parts.get(run.part) ?? parts.set(run.part, []).get(run.part)!;
    if (run.cell) {
      // a number or date cell holding a masked value becomes a text cell (its formula goes too)
      const tag = x.slice(run.cell.start, run.cell.tagEnd + 1).replace(/\s+t="[^"]*"/, '').replace(/\/?>$/, ' t="inlineStr">');
      list.push({ start: run.cell.start, end: run.cell.end, text: `${tag}<is><t xml:space="preserve">${encode(text)}</t></is></c>` });
      continue;
    }
    list.push({ start: run.s, end: run.e, text: encode(text, run.kind === 'attr') });
    if (run.drop) list.push({ start: run.drop[0], end: run.drop[1], text: '' });
    // leading or trailing spaces in w:t / t need xml:space="preserve"
    if (run.space >= 0 && /^\s|\s$/.test(text) && !/xml:space=/.test(x.slice(x.lastIndexOf('<', run.space), run.space))) list.push({ start: run.space, end: run.space, text: ' xml:space="preserve"' });
  }
  return out;
}

export interface RedactedImage {
  bytes: Uint8Array;
  mime: string;
  /** pixel size (an SVG wrapper needs it) */
  width?: number;
  height?: number;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg' };

/**
 * The redacted copy: masked text in the XML, every picture replaced by its redacted copy (all
 * of them are required), embedded files rebuilt the same way, metadata already scrubbed.
 */
export function buildCopy(f: OfficeFile, reps: Replacement[], images: Map<string, RedactedImage>): Uint8Array {
  const edits = runEdits(f, reps);
  const write = (file: OfficeFile, key: string): Uint8Array => {
    const p = file.pkg.clone();
    for (const [part, list] of edits.get(key) ?? []) p.setXml(part, splice(p.xml(part), list));
    for (const m of file.media) {
      if (m.pkg !== key) continue;
      const img = images.get(m.path);
      if (!img) throw new Error(`the picture ${m.part} has no redacted copy`);
      const ext = EXT[img.mime];
      if (!ext) throw new Error(`unexpected picture type ${img.mime}`);
      const cur = m.part.slice(m.part.lastIndexOf('.') + 1).toLowerCase();
      const same = cur === ext || (ext === 'jpeg' && cur === 'jpg');
      if (same) p.setBytes(m.part, img.bytes);
      else if (cur === 'svg') {
        // an SVG becomes an SVG showing the redacted raster (Office prefers the SVG over its fallback)
        p.setBytes(m.part, svgWrapper(img));
      } else {
        const to = m.part.replace(/\.[^./]+$/, '.' + ext);
        p.renamePart(m.part, to, img.mime);
        p.setBytes(to, img.bytes);
      }
    }
    for (const [part, child] of file.embedded) if (!key) p.setBytes(part, write(child, part));
    return p.write();
  };
  return write(f, '');
}

function svgWrapper(img: RedactedImage): Uint8Array {
  let s = '';
  for (let i = 0; i < img.bytes.length; i += 0x8000) s += String.fromCharCode(...img.bytes.subarray(i, i + 0x8000));
  const w = img.width ?? 100;
  const h = img.height ?? 100;
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" href="data:${img.mime};base64,${btoa(s)}"/></svg>`);
}
