// A small offset-aware XML tokenizer for the parts of Office files (well-formed XML written by
// Office apps). Edits are made on the raw string, so every token keeps its offsets. Linear time.

export interface Tag {
  /** qualified name, e.g. w:t */
  name: string;
  /** offset of '<' and offset just after '>' */
  start: number;
  end: number;
  close: boolean;
  self: boolean;
}

const NAME_END = /[\s/>]/;

/** Start, end and empty-element tags in document order; comments, PIs, CDATA and DOCTYPE are skipped. */
export function* tags(xml: string, from = 0, to = xml.length): Generator<Tag> {
  let i = xml.indexOf('<', from);
  while (i >= 0 && i < to) {
    const c = xml[i + 1];
    if (c === '?' || c === '!') {
      const close = c === '?' ? '?>' : xml.startsWith('<!--', i) ? '-->' : xml.startsWith('<![CDATA[', i) ? ']]>' : '>';
      const e = xml.indexOf(close, i + 2);
      i = e < 0 ? -1 : xml.indexOf('<', e + close.length);
      continue;
    }
    const close = c === '/';
    const j = i + (close ? 2 : 1);
    let k = j;
    while (k < xml.length && !NAME_END.test(xml[k])) k++;
    let q = '';
    let e = k;
    for (; e < xml.length; e++) {
      const ch = xml[e];
      if (q) {
        if (ch === q) q = '';
      } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') break;
    }
    yield { name: xml.slice(j, k), start: i, end: e + 1, close, self: !close && xml[e - 1] === '/' };
    i = xml.indexOf('<', e + 1);
  }
}

export interface Attr {
  name: string;
  /** raw (escaped) value and its offsets in the XML */
  raw: string;
  start: number;
  end: number;
}

/** The attributes of a start or empty tag. */
export function attrs(xml: string, t: Tag): Attr[] {
  const out: Attr[] = [];
  let i = t.start + 1 + t.name.length;
  const stop = t.end - (t.self ? 2 : 1);
  while (i < stop) {
    while (i < stop && /\s/.test(xml[i])) i++;
    let k = i;
    while (k < stop && xml[k] !== '=' && !/\s/.test(xml[k])) k++;
    const name = xml.slice(i, k);
    while (k < stop && xml[k] !== '"' && xml[k] !== "'") k++;
    const q = xml[k];
    if (!name || !q) break;
    const e = xml.indexOf(q, k + 1);
    if (e < 0) break;
    out.push({ name, raw: xml.slice(k + 1, e), start: k + 1, end: e });
    i = e + 1;
  }
  return out;
}

export const attr = (xml: string, t: Tag, name: string): Attr | undefined => attrs(xml, t).find((a) => a.name === name);

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decoded text and, for each UTF-16 unit of it, the offset of its source in the raw string (plus one entry for the end). */
export function decodeMap(raw: string): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === '&') {
      const semi = raw.indexOf(';', i + 1);
      const ent = semi > i && semi - i <= 10 ? raw.slice(i + 1, semi) : '';
      let ch: string | undefined = ENT[ent];
      if (ch === undefined && ent.startsWith('#')) {
        const n = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (Number.isFinite(n) && n >= 0 && n <= 0x10ffff) ch = String.fromCodePoint(n);
      }
      if (ch !== undefined) {
        for (let u = 0; u < ch.length; u++) at.push(i);
        text += ch;
        i = semi + 1;
        continue;
      }
    }
    at.push(i);
    text += raw[i];
    i++;
  }
  at.push(raw.length);
  return { text, at };
}

export const decode = (raw: string): string => (raw.includes('&') ? decodeMap(raw).text : raw);

/** Escape text for element content, or for an attribute value (quotes too). Characters XML 1.0 forbids are dropped. */
export function encode(s: string, inAttr = false): string {
  // control characters other than tab, LF and CR are not allowed in XML 1.0
  const clean = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
  const t = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return inAttr ? t.replace(/"/g, '&quot;') : t;
}

export interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping splices (overlapping ones are dropped, the earliest wins; a splice inside a removed range is dropped). */
export function splice(xml: string, edits: Splice[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) continue;
    out += xml.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + xml.slice(pos);
}

/** Ranges of elements with these names, content included (outermost only). */
export function elementRanges(xml: string, names: Set<string>): { start: number; end: number; name: string; contentStart: number; contentEnd: number }[] {
  const out: { start: number; end: number; name: string; contentStart: number; contentEnd: number }[] = [];
  let open: { name: string; start: number; contentStart: number; depth: number } | null = null;
  for (const t of tags(xml)) {
    if (open) {
      if (t.name !== open.name) continue;
      if (t.close) {
        if (--open.depth === 0) {
          out.push({ name: open.name, start: open.start, end: t.end, contentStart: open.contentStart, contentEnd: t.start });
          open = null;
        }
      } else if (!t.self) open.depth++;
      continue;
    }
    if (t.close || !names.has(t.name)) continue;
    if (t.self) out.push({ name: t.name, start: t.start, end: t.end, contentStart: t.end, contentEnd: t.end });
    else open = { name: t.name, start: t.start, contentStart: t.end, depth: 1 };
  }
  return out;
}
