// SpreadsheetML: every sheet as a Markdown table (its first row is the header, so columns are
// classified by it), then the other places a workbook keeps text: comments, headers and footers,
// strings no cell shows any more, pivot table caches, data connections, drawings and charts.
import type { Pkg } from './package';
import { charts, common, drawingPart, TextBuilder, type Extras, type OfficeText } from './text';
import { attr, attrs, decode, tags } from './xml';

const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** the <t> elements of each shared string: [start, end, end of start tag] */
function sharedStrings(x: string): [number, number, number][][] {
  const out: [number, number, number][][] = [];
  let cur: [number, number, number][] | null = null;
  for (const t of tags(x)) {
    if (t.name === 'si') {
      if (t.self) out.push([]);
      else if (!t.close) cur = [];
      else if (cur) {
        out.push(cur);
        cur = null;
      }
    } else if (t.name === 't' && cur && !t.close && !t.self) cur.push([t.end, x.indexOf('</t>', t.end), t.end - 1]);
  }
  return out;
}

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** indices of cell formats that show a date */
function dateFormats(x: string): Set<number> {
  const custom = new Map<number, string>();
  for (const t of tags(x)) if (t.name === 'numFmt' && !t.close) custom.set(Number(attr(x, t, 'numFmtId')?.raw), decode(attr(x, t, 'formatCode')?.raw ?? ''));
  const out = new Set<number>();
  let inXfs = false;
  let i = 0;
  for (const t of tags(x)) {
    if (t.name === 'cellXfs') inXfs = !t.close && !t.self;
    else if (inXfs && t.name === 'xf' && !t.close) {
      const id = Number(attr(x, t, 'numFmtId')?.raw ?? 0);
      const code = (custom.get(id) ?? '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
      if (BUILTIN_DATES.has(id) || (/[yd]/i.test(code) && !/[#0?]/.test(code))) out.add(i);
      i++;
    }
  }
  return out;
}

function isoDate(serial: number, date1904: boolean): string {
  let days = serial + (date1904 ? 1462 : 0);
  if (!date1904 && serial < 60) days += 1; // Excel counts a 29 February 1900
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(days) * 86400000);
  return d.toISOString().slice(0, 10);
}

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

type Cell = (b: TextBuilder) => void;

export function xlsxText(p: Pkg, main: string, pkg = ''): OfficeText {
  const b = new TextBuilder(pkg);
  const ex: Extras = { fields: [], alt: [] };
  const wb = p.xml(main);
  const rels = p.rels(main);
  const relById = new Map(rels.map((r) => [r.id, r]));
  const date1904 = /<workbookPr\b[^>]*date1904="(?:1|true)"/.test(wb);
  const sstPart = rels.find((r) => r.type.endsWith('/sharedStrings') && p.has(r.part))?.part;
  const sstXml = sstPart ? p.xml(sstPart) : '';
  const sst = sstPart ? sharedStrings(sstXml) : [];
  const used = new Set<number>();
  const stylesPart = rels.find((r) => r.type.endsWith('/styles') && p.has(r.part))?.part;
  const dates = stylesPart ? dateFormats(p.xml(stylesPart)) : new Set<number>();

  const sheets: { name: string; part: string }[] = [];
  for (const t of tags(wb)) {
    if (t.name !== 'sheet' || t.close) continue;
    const r = relById.get(attr(wb, t, 'r:id')?.raw ?? '');
    if (r && !r.external && p.has(r.part)) sheets.push({ name: decode(attr(wb, t, 'name')?.raw ?? ''), part: r.part });
  }

  const headerFooter: [string, number, number][] = [];
  for (const { name, part } of sheets) {
    const x = p.xml(part);
    const rows: Map<number, Cell>[] = [];
    let row: Map<number, Cell> | null = null;
    let next = 0;
    let c: { start: number; tagEnd: number; col: number; type: string; style: number; v?: [number, number]; f?: [number, number]; is: [number, number, number][] } | null = null;
    let fOpen = -1;
    for (const t of tags(x)) {
      switch (t.name) {
        case 'row':
          if (!t.close) {
            row = new Map();
            rows.push(row);
            next = 0;
          }
          break;
        case 'c':
          if (t.close && c && row) {
            const cell = c;
            const end = t.end;
            const col = cell.col;
            const v = cell.v;
            const raw = v ? decode(x.slice(v[0], v[1])) : '';
            if (cell.type === 's' && v) {
              const si = sst[Number(raw)];
              if (si) {
                used.add(Number(raw));
                row.set(col, (s) => si.forEach(([a, e, sp]) => s.run(sstPart!, sstXml, a, e, { space: sp, inTable: true })));
              }
            } else if (cell.type === 'inlineStr') row.set(col, (s) => cell.is.forEach(([a, e, sp]) => s.run(part, x, a, e, { space: sp, inTable: true })));
            else if (cell.type === 'str' && v) row.set(col, (s) => s.run(part, x, v[0], v[1], { inTable: true, drop: cell.f }));
            else if (cell.type === 'b' && v) row.set(col, (s) => s.lit(raw === '1' ? 'TRUE' : 'FALSE'));
            else if (cell.type === 'e' && v) row.set(col, (s) => s.lit(raw));
            else if (v && raw) {
              const n = Number(raw);
              const shown = dates.has(cell.style) && Number.isFinite(n) ? isoDate(n, date1904) : /e/i.test(raw) && Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(0) : raw;
              row.set(col, (s) => s.run(part, x, v[0], v[1], { kind: 'num', shown, inTable: true, cell: { start: cell.start, tagEnd: cell.tagEnd, end } }));
            }
            c = null;
          } else if (!t.close) {
            const r = attr(x, t, 'r')?.raw;
            const col = r ? colIndex(r) : next;
            next = col + 1;
            if (!t.self) c = { start: t.start, tagEnd: t.end - 1, col, type: attr(x, t, 't')?.raw ?? 'n', style: Number(attr(x, t, 's')?.raw ?? 0), is: [] };
          }
          break;
        case 'v':
          if (c && !t.close && !t.self) c.v = [t.end, x.indexOf('</v>', t.end)];
          break;
        case 'f':
          if (c && !t.close) {
            if (t.self) c.f = [t.start, t.end];
            else fOpen = t.start;
          } else if (c && t.close && fOpen >= 0) {
            c.f = [fOpen, t.end];
            fOpen = -1;
          }
          break;
        case 't':
          if (c && !t.close && !t.self) c.is.push([t.end, x.indexOf('</t>', t.end), t.end - 1]);
          break;
        case 'oddHeader':
        case 'oddFooter':
        case 'evenHeader':
        case 'evenFooter':
        case 'firstHeader':
        case 'firstFooter':
          if (!t.close && !t.self) headerFooter.push([part, t.end, x.indexOf(`</${t.name}>`, t.end)]);
          break;
      }
    }
    b.section(`Sheet ${name}`, (s) => {
      const filled = rows.filter((r) => r.size);
      const width = Math.max(0, ...filled.map((r) => Math.max(...r.keys()) + 1));
      filled.forEach((r, i) => {
        s.sep('\n');
        s.lit('|');
        for (let col = 0; col < width; col++) {
          s.lit(' ');
          r.get(col)?.(s);
          s.unsep();
          s.lit(' |');
        }
        if (i === 0) {
          s.sep('\n');
          s.lit('|' + ' --- |'.repeat(width));
        }
      });
    });
  }

  b.section('Other text in the workbook', (s) => {
    sst.forEach((si, i) => {
      if (used.has(i)) return;
      si.forEach(([a, e, sp]) => s.run(sstPart!, sstXml, a, e, { space: sp }));
      s.sep('\n');
    });
  });
  b.section('Headers and footers', (s) => {
    for (const [part, a, e] of headerFooter) {
      s.run(part, p.xml(part), a, e);
      s.sep('\n');
    }
  });
  // comments (notes) and threaded comments of every sheet
  b.section('Comments', (s) => {
    for (const { part } of sheets) {
      for (const r of p.rels(part)) {
        if (r.external || !p.has(r.part)) continue;
        const x = p.xml(r.part);
        if (r.type.endsWith('/comments')) {
          for (const t of tags(x)) {
            if (t.name === 'comment' && t.close) s.sep('\n');
            else if (t.name === 't' && !t.close && !t.self) s.run(r.part, x, t.end, x.indexOf('</t>', t.end), { space: t.end - 1 });
          }
        } else if (/threadedComment/.test(r.type)) {
          for (const t of tags(x)) {
            if (t.name === 'text' && !t.close && !t.self) {
              s.run(r.part, x, t.end, x.indexOf('</text>', t.end));
              s.sep('\n');
            }
          }
        }
      }
    }
  });
  // pivot table caches keep a copy of the source data
  b.section('Pivot table caches', (s) => {
    for (const n of p.names().filter((x) => /^xl\/pivotCache\/pivotCache(?:Definition|Records)\d+\.xml$/.test(x)).sort(natural)) {
      const x = p.xml(n);
      for (const t of tags(x)) {
        if (t.name !== 's' || t.close) continue;
        const v = attrs(x, t).find((a) => a.name === 'v');
        if (v && v.raw.trim()) {
          s.run(n, x, v.start, v.end, { kind: 'attr' });
          s.sep('\n');
        }
      }
    }
  });
  b.section('Data connections', (s) => {
    for (const n of p.names().filter((x) => /^xl\/connections\.xml$/.test(x))) {
      const x = p.xml(n);
      for (const t of tags(x)) {
        if (t.close) continue;
        for (const a of attrs(x, t)) {
          if (!['connection', 'command', 'url', 'sourceFile', 'odcFile'].includes(a.name) || !a.raw.trim()) continue;
          s.run(n, x, a.start, a.end, { kind: 'attr' });
          s.sep('\n');
        }
      }
    }
  });
  b.section('Drawings', (s) => {
    for (const n of p.names().filter((x) => /^xl\/drawings\/drawing\d+\.xml$/.test(x)).sort(natural)) drawingPart(s, n, p.xml(n), ex);
  });
  charts(b, p, 'xl/', ex);
  common(b, p, ex);
  return b.done();
}
