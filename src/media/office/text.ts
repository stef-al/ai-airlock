// The text of an Office file, for review and detection, with every character mapped back to the
// XML it came from (a "run": part + raw offsets). Paragraphs become lines, tables become Markdown
// tables (so columns are classified by their header), other places that hold text (headers,
// comments, charts, alt text, link targets…) follow under a heading. Pure: runs in Node.
import { relsOf, type Pkg } from './package';
import { attrs, decode, tags } from './xml';

export interface Run {
  /** '' for the file itself, else the part of an embedded file in it */
  pkg: string;
  part: string;
  /** raw offsets of the text in the part */
  s: number;
  e: number;
  /** offset of the '>' of the start tag, where xml:space="preserve" goes (-1: not needed) */
  space: number;
  /** attribute values are escaped differently; 'num' is a number cell (becomes text when masked) */
  kind: 'text' | 'attr' | 'num';
  /** where the run is in the document text, and its length there */
  at: number;
  len: number;
  /** what the text shows when it differs from the XML (a date for a date serial number) */
  shown?: string;
  /** a number cell: the whole cell element, rewritten as a text cell when the run is masked */
  cell?: { start: number; tagEnd: number; end: number };
  /** XML removed when the run is masked (the formula of a cell whose result is masked) */
  drop?: [number, number];
}

export interface RunOpts {
  kind?: Run['kind'];
  /** offset of the start tag's '>' (xml:space goes there) */
  space?: number;
  /** inside a Markdown table: a pipe is shown as a broken bar */
  inTable?: boolean;
  shown?: string;
  cell?: Run['cell'];
  drop?: Run['drop'];
}

export interface OfficeText {
  text: string;
  runs: Run[];
}

type Sep = '' | ' ' | '\t' | '\n' | '\n\n';
const RANK: Record<Sep, number> = { '': 0, ' ': 1, '\t': 2, '\n': 3, '\n\n': 4 };

/** Text with runs; separators between pieces are merged (the strongest wins). */
export class TextBuilder {
  private chunks: string[] = [];
  private pending: Sep = '';
  len = 0;
  runs: Run[] = [];
  constructor(private pkg = '') {}

  sep(s: Sep) {
    if (RANK[s] > RANK[this.pending]) this.pending = s;
  }
  /** forget a pending separator (the end of a table cell brings its own) */
  unsep() {
    this.pending = '';
  }
  private push(s: string) {
    this.chunks.push(s);
    this.len += s.length;
  }
  private flush() {
    if (this.pending && this.len) this.push(this.pending);
    this.pending = '';
  }
  /** text of our own (markers, table syntax): not in the file */
  lit(s: string) {
    this.flush();
    this.push(s);
  }
  heading(title: string) {
    this.sep('\n\n');
    this.lit(`=== ${title} ===`);
    this.sep('\n');
  }
  /**
   * Text from the file. Line breaks inside it are shown as spaces, and in tables a pipe as a
   * broken bar, so lines and table cells stay intact (the length does not change).
   */
  run(part: string, xml: string, s: number, e: number, o: RunOpts = {}) {
    if (e <= s) return;
    const text = o.shown ?? decode(xml.slice(s, e));
    if (!text) return;
    this.flush();
    this.runs.push({ pkg: this.pkg, part, s, e, space: o.space ?? -1, kind: o.kind ?? 'text', at: this.len, len: text.length, shown: o.shown, cell: o.cell, drop: o.drop });
    let shown = text.replace(/[\r\n\t\v\f]/g, ' ');
    if (o.inTable) shown = shown.replace(/\|/g, '¦');
    this.push(shown);
  }
  /** another text (an embedded file) under a heading ('' for none) */
  append(title: string, t: OfficeText) {
    if (!t.text) return;
    if (title) this.heading(title);
    this.flush();
    const base = this.len;
    this.push(t.text);
    for (const r of t.runs) this.runs.push({ ...r, at: r.at + base });
    this.sep('\n');
  }
  done(): OfficeText {
    return { text: this.chunks.join(''), runs: this.runs };
  }
  /** a section under a heading, left out when it has no text */
  section(title: string, fill: (s: TextBuilder) => void) {
    const s = new TextBuilder(this.pkg);
    fill(s);
    this.append(title, s.done());
  }
}

const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const closeOf = (x: string, name: string, from: number) => x.indexOf(`</${name}>`, from);

/** Markdown table bookkeeping shared by WordprocessingML and DrawingML tables. */
class Tables {
  private stack: { row: number; cells: number }[] = [];
  cell = 0;
  constructor(private b: TextBuilder) {}
  table(open: boolean) {
    if (open) this.stack.push({ row: 0, cells: 0 });
    else this.stack.pop();
    this.b.sep('\n');
  }
  row(open: boolean) {
    const t = this.stack[this.stack.length - 1];
    if (!t) return;
    if (open) {
      this.b.sep('\n');
      this.b.lit('|');
      t.cells = 0;
      return;
    }
    // a separator row after the first one: the first row is the header
    if (t.row++ === 0 && t.cells) {
      this.b.sep('\n');
      this.b.lit('|' + ' --- |'.repeat(t.cells));
    }
    this.b.sep('\n');
  }
  tc(open: boolean) {
    const t = this.stack[this.stack.length - 1];
    if (!t) return;
    if (open) {
      this.b.lit(' ');
      t.cells++;
      this.cell++;
    } else {
      this.b.unsep();
      this.b.lit(' |');
      this.cell--;
    }
  }
}

export interface Extras {
  /** field instructions (HYPERLINK "…", MERGEFIELD…): [part, start, end] per field */
  fields: [string, number, number][][];
  /** alternative text of pictures and shapes: [part, start, end] */
  alt: [string, number, number][];
}

const ALT_ELEMENTS = /^(?:wp:docPr|pic:cNvPr|p:cNvPr|xdr:cNvPr|wps:cNvPr|dgm:cNvPr|a:cNvPr|wpg:cNvPr)$/;

function altText(x: string, t: { name: string; start: number; end: number; close: boolean; self: boolean }, part: string, ex: Extras) {
  if (t.close || !ALT_ELEMENTS.test(t.name)) return;
  for (const a of attrs(x, t as never)) if ((a.name === 'descr' || a.name === 'title') && a.raw.trim()) ex.alt.push([part, a.start, a.end]);
}

/** WordprocessingML: paragraphs, runs, tabs and breaks, tables, field codes, alt text. */
export function wordPart(b: TextBuilder, part: string, x: string, ex: Extras) {
  const tables = new Tables(b);
  let inRun = 0;
  let instr: [string, number, number][] = [];
  for (const t of tags(x)) {
    altText(x, t, part, ex);
    switch (t.name) {
      case 'w:p':
        if (t.close || t.self) {
          b.sep(tables.cell ? ' ' : '\n');
          if (instr.length) ex.fields.push(instr);
          instr = [];
        }
        break;
      case 'w:r':
        if (!t.self) inRun += t.close ? -1 : 1;
        break;
      case 'w:t':
        if (!t.close && !t.self) b.run(part, x, t.end, closeOf(x, 'w:t', t.end), { space: t.end - 1, inTable: tables.cell > 0 });
        break;
      case 'w:instrText':
        if (!t.close && !t.self) instr.push([part, t.end, closeOf(x, 'w:instrText', t.end)]);
        break;
      case 'w:tab':
        if (inRun > 0 && !t.close) b.lit(tables.cell ? ' ' : '\t');
        break;
      case 'w:br':
      case 'w:cr':
        if (inRun > 0 && !t.close) b.sep(tables.cell ? ' ' : '\n');
        break;
      case 'w:noBreakHyphen':
        if (!t.close) b.lit('-');
        break;
      case 'w:tbl':
        if (!t.self) tables.table(!t.close);
        break;
      case 'w:tr':
        if (!t.self) tables.row(!t.close);
        break;
      case 'w:tc':
        if (!t.self) tables.tc(!t.close);
        break;
    }
  }
  b.sep('\n');
}

const STR_CACHE = new Set(['c:strCache', 'c:strLit', 'c:multiLvlStrCache', 'cx:strDim', 'cx:lvl']);

/**
 * Shapes that are placeholders of a master or layout ("Click to edit Master title style"): their
 * prompts are not text of the document. Footers are (company names, "Confidential").
 */
function placeholderShapes(x: string): [number, number][] {
  const out: [number, number][] = [];
  let at = x.indexOf('<p:sp>');
  while (at >= 0) {
    const end = x.indexOf('</p:sp>', at);
    if (end < 0) break;
    const nv = x.slice(at, x.indexOf('</p:nvSpPr>', at));
    if (/<p:ph\b/.test(nv) && !/<p:ph\b[^>]*type="ftr"/.test(nv)) out.push([at, end]);
    at = x.indexOf('<p:sp>', end);
  }
  return out;
}

/** DrawingML (slides, shapes, charts, SmartArt): paragraphs of a:t runs, tables, chart labels, alt text. */
export function drawingPart(b: TextBuilder, part: string, x: string, ex: Extras, template = false) {
  const tables = new Tables(b);
  let str = 0;
  const skipped = template ? placeholderShapes(x) : [];
  const skip = (pos: number) => skipped.some(([a, e]) => pos > a && pos < e);
  for (const t of tags(x)) {
    altText(x, t, part, ex);
    switch (t.name) {
      case 'a:p':
        if (t.close || t.self) b.sep(tables.cell ? ' ' : '\n');
        break;
      case 'a:t':
        if (!t.close && !t.self && !skip(t.start)) b.run(part, x, t.end, closeOf(x, 'a:t', t.end), { inTable: tables.cell > 0 });
        break;
      case 'a:br':
        if (!t.close) b.sep(tables.cell ? ' ' : '\n');
        break;
      case 'a:tbl':
        if (!t.self) tables.table(!t.close);
        break;
      case 'a:tr':
        if (!t.self) tables.row(!t.close);
        break;
      case 'a:tc':
        if (!t.self) tables.tc(!t.close);
        break;
      case 'c:v':
      case 'cx:pt':
        // category and series names cached in a chart (numbers are left as they are)
        if (str > 0 && !t.close && !t.self) {
          b.run(part, x, t.end, closeOf(x, t.name, t.end));
          b.sep('\n');
        }
        break;
      default:
        if (STR_CACHE.has(t.name) && !t.self) str += t.close ? -1 : 1;
    }
  }
  b.sep('\n');
}

/** Any XML (custom XML data): the text of every element. */
export function leafPart(b: TextBuilder, part: string, x: string) {
  let prev: { name: string; end: number; close: boolean; self: boolean } | null = null;
  for (const t of tags(x)) {
    if (prev && !prev.close && !prev.self && t.close && t.name === prev.name && x.slice(prev.end, t.start).trim()) {
      b.run(part, x, prev.end, t.start);
      b.sep('\n');
    }
    prev = t;
  }
}

/** The places every kind of file shares: alt text, field codes, link targets. */
export function common(b: TextBuilder, p: Pkg, ex: Extras) {
  b.section('Field codes', (s) => {
    for (const f of ex.fields) {
      for (const [part, a, e] of f) s.run(part, p.xml(part), a, e);
      s.sep('\n');
    }
  });
  b.section('Alt text', (s) => {
    for (const [part, a, e] of ex.alt) {
      s.run(part, p.xml(part), a, e, { kind: 'attr' });
      s.sep('\n');
    }
  });
  b.section('Links', (s) => {
    for (const r of p.allRels()) {
      if (!r.external || !r.target.trim() || r.target.startsWith('#')) continue;
      const rels = relsOf(r.source);
      s.run(rels, p.xml(rels), r.targetStart, r.targetEnd, { kind: 'attr' });
      s.sep('\n');
    }
  });
  b.section('Custom XML data', (s) => {
    for (const n of p.names().filter((x) => /^customXml\/item\d+\.xml$/i.test(x)).sort(natural)) leafPart(s, n, p.xml(n));
  });
}

export function charts(b: TextBuilder, p: Pkg, prefix: string, ex: Extras) {
  b.section('Charts and diagrams', (s) => {
    for (const n of p.names().filter((x) => x.startsWith(prefix) && /\/(?:charts\/chart(?:Ex)?\d*|diagrams\/(?:data|drawing)\d*)\.xml$/i.test(x)).sort(natural)) drawingPart(s, n, p.xml(n), ex);
  });
}

/** DOCX: body, headers and footers, notes, comments, charts, then the common places. */
export function docxText(p: Pkg, main: string, pkg = ''): OfficeText {
  const b = new TextBuilder(pkg);
  const ex: Extras = { fields: [], alt: [] };
  wordPart(b, main, p.xml(main), ex);
  const rels = p.rels(main);
  const byType = (t: string) => rels.filter((r) => !r.external && r.type.endsWith('/' + t) && p.has(r.part)).map((r) => r.part).sort(natural);
  for (const [type, title] of [['header', 'Header'], ['footer', 'Footer'], ['footnotes', 'Footnotes'], ['endnotes', 'Endnotes'], ['comments', 'Comments'], ['glossaryDocument', 'Building blocks']] as const) {
    for (const part of byType(type)) b.section(title, (s) => wordPart(s, part, p.xml(part), ex));
  }
  charts(b, p, 'word/', ex);
  // document variables (macros and add-ins keep values there)
  for (const settings of byType('settings')) {
    const x = p.xml(settings);
    b.section('Document variables', (s) => {
      for (const t of tags(x)) {
        if (t.name !== 'w:docVar' || t.close) continue;
        const v = attrs(x, t).find((a) => a.name === 'w:val');
        if (v) {
          s.run(settings, x, v.start, v.end, { kind: 'attr' });
          s.sep('\n');
        }
      }
    });
  }
  common(b, p, ex);
  return b.done();
}
