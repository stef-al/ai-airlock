// What an Office file carries besides its visible text, made harmless before anything else:
// tracked changes accepted (deleted text is gone), authors renamed, document properties emptied,
// thumbnail, macros and printer settings removed, pictures and objects that cannot be checked
// replaced by blanks. Pure: runs in Node.
import { gzipSync } from 'fflate';
import type { Pkg } from './package';
import { attrs, decode, elementRanges, encode, splice, tags, type Splice } from './xml';

export interface ScrubReport {
  /** document properties that were emptied or removed: [name, value] */
  properties: [string, string][];
  thumbnail: boolean;
  /** original author names, in order of "Author 1", "Author 2"… */
  authors: string[];
  changes: { insertions: number; deletions: number; formatting: number };
  macros: boolean;
  /** parts removed (thumbnail, custom properties, macros, printer settings) */
  removed: string[];
  /** pictures and embedded objects replaced by blanks because they cannot be checked */
  blanked: string[];
}

export const emptyReport = (): ScrubReport => ({ properties: [], thumbnail: false, authors: [], changes: { insertions: 0, deletions: 0, formatting: 0 }, macros: false, removed: [], blanked: [] });

const isXmlPart = (p: Pkg, n: string) => p.isXml(n) && !n.endsWith('.rels') && n !== '[Content_Types].xml';
const relType = (suffix: string) => (t: string) => t.endsWith('/' + suffix);

// ---------------------------------------------------------------------------------------------
// tracked changes (WordprocessingML)

/** deleted content and records of formatting changes: removed with their content */
const DROP = new Set(['w:del', 'w:moveFrom', 'w:rPrChange', 'w:pPrChange', 'w:sectPrChange', 'w:tblPrChange', 'w:tblGridChange', 'w:trPrChange', 'w:tcPrChange', 'w:numberingChange', 'w:cellDel', 'w:cellIns', 'w:cellMerge', 'w:moveFromRangeStart', 'w:moveFromRangeEnd', 'w:moveToRangeStart', 'w:moveToRangeEnd']);
/** inserted content: kept, the marks around it removed */
const UNWRAP = new Set(['w:ins', 'w:moveTo']);

export function acceptChanges(xml: string): { xml: string; insertions: number; deletions: number; formatting: number } {
  if (!/<w:(?:del|ins|moveFrom|moveTo|\w+Change|cell(?:Del|Ins|Merge))\b/.test(xml)) return { xml, insertions: 0, deletions: 0, formatting: 0 };
  const edits: Splice[] = [];
  let insertions = 0;
  let deletions = 0;
  let formatting = 0;
  for (const r of elementRanges(xml, DROP)) {
    edits.push({ start: r.start, end: r.end, text: '' });
    if ((r.name === 'w:del' || r.name === 'w:moveFrom') && r.contentEnd > r.contentStart) deletions++;
    else if (r.name.endsWith('Change')) formatting++;
  }
  for (const t of tags(xml)) {
    if (!UNWRAP.has(t.name)) continue;
    edits.push({ start: t.start, end: t.end, text: '' });
    if (!t.close && !t.self) insertions++;
  }
  return { xml: splice(xml, edits), insertions, deletions, formatting };
}

// ---------------------------------------------------------------------------------------------
// authors

type Role = 'name' | 'initials' | 'id' | 'provider';
/** author attributes, on any element or on one element */
const ANY: Record<string, Role> = { 'w:author': 'name', 'w15:author': 'name', 'w:initials': 'initials' };
const ON: Record<string, Record<string, Role>> = {
  'p:cmAuthor': { name: 'name', initials: 'initials' },
  'p188:author': { name: 'name', initials: 'initials', userId: 'id', providerId: 'provider' },
  person: { displayName: 'name', userId: 'id', providerId: 'provider' },
  'x18tc:person': { displayName: 'name', userId: 'id', providerId: 'provider' },
};
const LIKELY = /author|initials|userId|displayName|providerId|name=/;

function renameAuthors(p: Pkg, report: ScrubReport) {
  const names = new Map<string, number>();
  const num = (n: string) => {
    if (!names.has(n)) {
      names.set(n, names.size + 1);
      report.authors.push(n);
    }
    return names.get(n)!;
  };
  for (const part of p.names().filter((n) => isXmlPart(p, n))) {
    const x = p.xml(part);
    if (!/author|person|people/i.test(x.slice(0, 4000)) && !/w:author=|w15:author=/.test(x)) continue;
    const edits: Splice[] = [];
    for (const t of tags(x)) {
      if (t.name === 'w15:presenceInfo' && !t.close) {
        edits.push({ start: t.start, end: t.end, text: '' }); // user id and email of the author
        continue;
      }
      if (t.close || !LIKELY.test(x.slice(t.start, t.end))) continue;
      const roles = ON[t.name] ?? {};
      const as = attrs(x, t).filter((a) => ANY[a.name] || roles[a.name]);
      if (!as.length) continue;
      const nameAttr = as.find((a) => (ANY[a.name] ?? roles[a.name]) === 'name');
      const n = nameAttr ? num(decode(nameAttr.raw)) : 0;
      for (const a of as) {
        const role = ANY[a.name] ?? roles[a.name];
        const v = role === 'name' ? `Author ${n}` : role === 'initials' ? (n ? `A${n}` : 'A') : role === 'provider' ? 'None' : '';
        edits.push({ start: a.start, end: a.end, text: v });
      }
    }
    // author names as element text (SpreadsheetML comments)
    if (/<author>/.test(x)) {
      let open = -1;
      for (const t of tags(x)) {
        if (t.name !== 'author') continue;
        if (!t.close && !t.self) open = t.end;
        else if (t.close && open >= 0) {
          const name = decode(x.slice(open, t.start));
          if (name.trim()) edits.push({ start: open, end: t.start, text: `Author ${num(name)}` });
          open = -1;
        }
      }
    }
    if (edits.length) p.setXml(part, splice(x, edits));
  }
}

// ---------------------------------------------------------------------------------------------
// document properties, thumbnail, macros, printer settings

const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>`;
const app = (application: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${application ? `<Application>${encode(application)}</Application>` : ''}</Properties>`;

/** leaf elements with text: [local name, text] */
function leafValues(x: string): [string, string][] {
  const out: [string, string][] = [];
  let last: { name: string; end: number } | null = null;
  for (const t of tags(x)) {
    if (!t.close && !t.self) last = { name: t.name, end: t.end };
    else if (t.close && last && last.name === t.name) {
      const v = decode(x.slice(last.end, t.start)).trim();
      if (v) out.push([t.name.replace(/^\w+:/, ''), v]);
      last = null;
    } else last = null;
  }
  return out;
}

function scrubProperties(p: Pkg, report: ScrubReport) {
  for (const r of p.rels('')) {
    if (r.external || !p.has(r.part)) continue;
    if (relType('metadata/core-properties')(r.type)) {
      report.properties.push(...leafValues(p.xml(r.part)));
      p.setXml(r.part, CORE);
    } else if (relType('extended-properties')(r.type)) {
      const vals = leafValues(p.xml(r.part));
      report.properties.push(...vals.filter(([k]) => ['Company', 'Manager', 'HyperlinkBase', 'Template'].includes(k)));
      p.setXml(r.part, app(vals.find(([k]) => k === 'Application')?.[1] ?? ''));
    } else if (relType('custom-properties')(r.type)) {
      const x = p.xml(r.part);
      for (const t of tags(x)) {
        if (t.name !== 'property' || t.close) continue;
        const name = attrs(x, t).find((a) => a.name === 'name');
        const end = x.indexOf('</property>', t.end);
        const value = end > 0 ? decode(x.slice(t.end, end).replace(/<[^>]*>/g, '')).trim() : '';
        if (name) report.properties.push([decode(name.raw), value]);
      }
      p.removePart(r.part);
      report.removed.push(r.part);
    } else if (relType('metadata/thumbnail')(r.type)) {
      p.removePart(r.part);
      report.thumbnail = true;
      report.removed.push(r.part);
    }
  }
}

function removeExtras(p: Pkg, report: ScrubReport) {
  for (const r of p.allRels()) {
    if (r.external || !p.has(r.part)) continue;
    if (relType('vbaProject')(r.type)) {
      for (const sub of p.rels(r.part)) if (!sub.external && p.has(sub.part)) {
        p.removePart(sub.part);
        report.removed.push(sub.part);
      }
      p.removePart(r.part);
      report.removed.push(r.part);
      report.macros = true;
    } else if (relType('printerSettings')(r.type)) {
      p.removePart(r.part);
      report.removed.push(r.part);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// blanks for what cannot be checked

/** an empty Enhanced Metafile (header and end-of-file records) */
export function blankEmf(): Uint8Array {
  const b = new DataView(new ArrayBuffer(108));
  const u32 = (o: number, v: number) => b.setUint32(o, v, true);
  u32(0, 1); // EMR_HEADER
  u32(4, 88);
  u32(32, 100); // rclFrame right, bottom (0.01 mm)
  u32(36, 100);
  u32(40, 0x464d4520); // " EMF"
  u32(44, 0x10000);
  u32(48, 108);
  u32(52, 2);
  b.setUint16(56, 1, true);
  u32(72, 1024); // device size in pixels and millimetres
  u32(76, 768);
  u32(80, 320);
  u32(84, 240);
  u32(88, 14); // EMR_EOF
  u32(92, 20);
  u32(100, 16);
  u32(104, 20);
  return new Uint8Array(b.buffer);
}

/** an empty placeable Windows Metafile */
export function blankWmf(): Uint8Array {
  const b = new DataView(new ArrayBuffer(46));
  const u16 = (o: number, v: number) => b.setUint16(o, v, true);
  b.setUint32(0, 0x9ac6cdd7, true);
  u16(10, 100); // bounding box right, bottom
  u16(12, 100);
  u16(14, 1440);
  let sum = 0;
  for (let i = 0; i < 20; i += 2) sum ^= b.getUint16(i, true);
  u16(20, sum);
  u16(22, 1); // META_HEADER
  u16(24, 9);
  u16(26, 0x300);
  b.setUint32(28, 12, true);
  b.setUint32(34, 3, true);
  b.setUint32(40, 3, true); // META_EOF
  return new Uint8Array(b.buffer);
}

const VECTOR = /\.(emf|wmf|emz|wmz)$/i;

/** EMF/WMF pictures (no decoder in a browser) and embedded OLE objects: replaced by empty ones */
function blankUncheckable(p: Pkg, report: ScrubReport) {
  for (const n of p.names()) {
    const m = VECTOR.exec(n);
    if (m) {
      const kind = m[1].toLowerCase();
      const blank = kind.startsWith('e') ? blankEmf() : blankWmf();
      p.setBytes(n, kind.endsWith('z') ? gzipSync(blank) : blank);
      report.blanked.push(n);
    }
  }
  for (const r of p.allRels()) {
    if (r.external || !p.has(r.part) || report.blanked.includes(r.part)) continue;
    // OLE objects and ActiveX controls (binary; an embedded Office file is handled as a document)
    if ((relType('oleObject')(r.type) || relType('control')(r.type) || relType('activeXControlBinary')(r.type)) && !/\.(?:docx|xlsx|pptx|docm|xlsm|pptm)$/i.test(r.part)) {
      p.setBytes(r.part, new Uint8Array());
      report.blanked.push(r.part);
    }
  }
}

/** All of the above, in place. Run before the text is read: offsets change. */
export function scrub(p: Pkg, kind: 'docx' | 'pptx' | 'xlsx'): ScrubReport {
  const report = emptyReport();
  if (kind === 'docx') {
    for (const n of p.names().filter((x) => x.startsWith('word/') && isXmlPart(p, x))) {
      const r = acceptChanges(p.xml(n));
      if (r.xml === p.xml(n)) continue;
      p.setXml(n, r.xml);
      report.changes.insertions += r.insertions;
      report.changes.deletions += r.deletions;
      report.changes.formatting += r.formatting;
    }
  }
  scrubProperties(p, report);
  removeExtras(p, report);
  renameAuthors(p, report);
  blankUncheckable(p, report);
  return report;
}
