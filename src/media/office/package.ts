// An Office Open XML package (DOCX, PPTX, XLSX): a ZIP of parts, their content types and the
// relationships between them. Parts are edited in memory and written back as a new ZIP.
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { attr, decode, encode, splice, tags, type Splice } from './xml';

export type OfficeKind = 'docx' | 'pptx' | 'xlsx';

export interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
  /** the part an internal target points at */
  part: string;
  /** the part that holds the relationship ('' for the package) */
  source: string;
  /** offsets of the Relationship element and of its Target value in the .rels XML */
  start: number;
  end: number;
  targetStart: number;
  targetEnd: number;
}

const CT = '[Content_Types].xml';
/** ZIP timestamps carry no information about the original file */
const MTIME = new Date(Date.UTC(2000, 0, 1));

/** the .rels part of a part ('' = the package) */
export function relsOf(part: string): string {
  const i = part.lastIndexOf('/');
  return part.slice(0, i + 1) + '_rels/' + part.slice(i + 1) + '.rels';
}

/** the part a .rels part belongs to */
export function sourceOf(rels: string): string {
  const m = /^(.*?)_rels\/(.*)\.rels$/.exec(rels);
  return m ? m[1] + m[2] : '';
}

/** a relationship target resolved against its source part (part names have no leading slash) */
export function resolve(source: string, target: string): string {
  let t = target;
  try {
    t = decodeURIComponent(target);
  } catch {
    /* keep it as written */
  }
  const base = t.startsWith('/') ? '' : source.slice(0, source.lastIndexOf('/') + 1);
  const out: string[] = [];
  for (const seg of (base + t.replace(/^\//, '')).split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

const XML_EXT = /\.(?:xml|rels|vml)$/i;

export class Pkg {
  files = new Map<string, Uint8Array>();
  private xmlCache = new Map<string, string>();
  private utf16 = new Set<string>();
  /** original entry order (kept on write) */
  private order: string[] = [];

  static read(bytes: Uint8Array): Pkg {
    const p = new Pkg();
    const files = unzipSync(bytes);
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('/')) continue;
      p.files.set(name, data);
      p.order.push(name);
    }
    if (!p.files.has(CT)) throw new Error('not an Office Open XML file (no [Content_Types].xml)');
    return p;
  }

  /** an independent copy (bytes and texts are shared until changed) */
  clone(): Pkg {
    const p = new Pkg();
    p.files = new Map(this.files);
    p.xmlCache = new Map(this.xmlCache);
    p.utf16 = new Set(this.utf16);
    p.order = [...this.order];
    return p;
  }

  has(name: string): boolean {
    return this.files.has(name) || this.xmlCache.has(name);
  }

  isXml(name: string): boolean {
    return XML_EXT.test(name) || /xml/.test(this.contentType(name) ?? '');
  }

  /** a part as text (decoded once; edits replace it) */
  xml(name: string): string {
    let s = this.xmlCache.get(name);
    if (s !== undefined) return s;
    const b = this.files.get(name);
    if (!b) return '';
    if (b[0] === 0xff && b[1] === 0xfe) {
      this.utf16.add(name);
      s = new TextDecoder('utf-16le').decode(b.subarray(2));
    } else s = new TextDecoder('utf-8').decode(b);
    this.xmlCache.set(name, s);
    return s;
  }

  setXml(name: string, s: string) {
    this.xmlCache.set(name, s);
    if (!this.files.has(name)) {
      this.files.set(name, new Uint8Array());
      this.order.push(name);
    }
  }

  bytes(name: string): Uint8Array | undefined {
    const s = this.xmlCache.get(name);
    if (s === undefined) return this.files.get(name);
    if (!this.utf16.has(name)) return new TextEncoder().encode(s);
    const out = new Uint8Array(2 + s.length * 2);
    out[0] = 0xff;
    out[1] = 0xfe;
    for (let i = 0; i < s.length; i++) {
      out[2 + i * 2] = s.charCodeAt(i) & 255;
      out[3 + i * 2] = s.charCodeAt(i) >> 8;
    }
    return out;
  }

  setBytes(name: string, b: Uint8Array) {
    this.xmlCache.delete(name);
    if (!this.files.has(name)) this.order.push(name);
    this.files.set(name, b);
  }

  names(): string[] {
    return this.order.filter((n) => this.files.has(n));
  }

  write(): Uint8Array {
    const z: Zippable = {};
    // [Content_Types].xml first, as Office writes it
    for (const n of [CT, ...this.names().filter((x) => x !== CT)]) z[n] = [this.bytes(n)!, { level: /\.(?:png|jpe?g|gif|zip|docx|xlsx|pptx)$/i.test(n) ? 0 : 6, mtime: MTIME }];
    return zipSync(z);
  }

  // ------------------------------------------------------------------------------------------
  // content types

  contentType(name: string): string | undefined {
    const ct = this.xmlCache.get(CT) ?? new TextDecoder().decode(this.files.get(CT) ?? new Uint8Array());
    const want = '/' + name.toLowerCase();
    let def: string | undefined;
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    for (const t of tags(ct)) {
      if (t.close) continue;
      if (t.name === 'Override' && attr(ct, t, 'PartName')?.raw.toLowerCase() === want) return attr(ct, t, 'ContentType')?.raw;
      if (t.name === 'Default' && attr(ct, t, 'Extension')?.raw.toLowerCase() === ext) def = attr(ct, t, 'ContentType')?.raw;
    }
    return def;
  }

  /** a Default content type for an extension (added when missing) */
  ensureDefault(ext: string, type: string) {
    const ct = this.xml(CT);
    for (const t of tags(ct)) if (t.name === 'Default' && attr(ct, t, 'Extension')?.raw.toLowerCase() === ext) return;
    const at = ct.indexOf('>', ct.indexOf('<Types')) + 1;
    this.setXml(CT, ct.slice(0, at) + `<Default Extension="${ext}" ContentType="${type}"/>` + ct.slice(at));
  }

  // ------------------------------------------------------------------------------------------
  // relationships

  rels(source: string): Rel[] {
    const name = relsOf(source);
    if (!this.has(name)) return [];
    const x = this.xml(name);
    const out: Rel[] = [];
    for (const t of tags(x)) {
      if (t.close || t.name !== 'Relationship') continue;
      const target = attr(x, t, 'Target');
      if (!target) continue;
      const external = attr(x, t, 'TargetMode')?.raw === 'External';
      const raw = decode(target.raw);
      out.push({
        id: attr(x, t, 'Id')?.raw ?? '',
        type: attr(x, t, 'Type')?.raw ?? '',
        target: raw,
        external,
        part: external ? '' : resolve(source, raw),
        source,
        start: t.start,
        end: t.end,
        targetStart: target.start,
        targetEnd: target.end,
      });
    }
    return out;
  }

  /** every relationship of the package */
  allRels(): Rel[] {
    return this.names()
      .filter((n) => n.endsWith('.rels'))
      .flatMap((r) => this.rels(sourceOf(r)));
  }

  /** the main part (word/document.xml, ppt/presentation.xml, xl/workbook.xml) and the kind of file */
  main(): { part: string; kind: OfficeKind } | null {
    const r = this.rels('').find((x) => /\/officeDocument$/.test(x.type) && !x.external);
    if (!r) return null;
    const kind = r.part.startsWith('word/') ? 'docx' : r.part.startsWith('ppt/') ? 'pptx' : r.part.startsWith('xl/') ? 'xlsx' : null;
    return kind ? { part: r.part, kind } : null;
  }

  /** remove a part, its own relationships, its content type override and every relationship pointing at it */
  removePart(name: string) {
    this.files.delete(name);
    this.xmlCache.delete(name);
    const own = relsOf(name);
    this.files.delete(own);
    this.xmlCache.delete(own);
    const ct = this.xml(CT);
    const edits: Splice[] = [];
    for (const t of tags(ct)) if (t.name === 'Override' && attr(ct, t, 'PartName')?.raw.toLowerCase() === '/' + name.toLowerCase()) edits.push({ start: t.start, end: t.end, text: '' });
    if (edits.length) this.setXml(CT, splice(ct, edits));
    for (const r of this.names().filter((n) => n.endsWith('.rels'))) {
      const rel = this.rels(sourceOf(r)).filter((x) => !x.external && x.part === name);
      if (rel.length) this.setXml(r, splice(this.xml(r), rel.map((x) => ({ start: x.start, end: x.end, text: '' }))));
    }
  }

  /** move a part to a new name (another extension): relationships and content types follow */
  renamePart(from: string, to: string, type: string) {
    const b = this.bytes(from);
    if (!b) return;
    const ct = this.xml(CT);
    const edits: Splice[] = [];
    for (const t of tags(ct)) if (t.name === 'Override' && attr(ct, t, 'PartName')?.raw.toLowerCase() === '/' + from.toLowerCase()) edits.push({ start: t.start, end: t.end, text: `<Override PartName="/${encode(to, true)}" ContentType="${type}"/>` });
    if (edits.length) this.setXml(CT, splice(ct, edits));
    else this.ensureDefault(to.slice(to.lastIndexOf('.') + 1).toLowerCase(), type);
    const oldBase = from.slice(from.lastIndexOf('/') + 1);
    const newBase = to.slice(to.lastIndexOf('/') + 1);
    for (const r of this.names().filter((n) => n.endsWith('.rels'))) {
      const rel = this.rels(sourceOf(r)).filter((x) => !x.external && x.part === from);
      if (!rel.length) continue;
      const x = this.xml(r);
      this.setXml(r, splice(x, rel.map((y) => ({ start: y.targetStart, end: y.targetEnd, text: encode(y.target.slice(0, y.target.length - oldBase.length) + newBase, true) }))));
    }
    this.files.delete(from);
    this.xmlCache.delete(from);
    this.setBytes(to, b);
  }
}
