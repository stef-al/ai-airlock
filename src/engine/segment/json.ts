import { visit } from 'jsonc-parser';
import type { Pair } from '../types';
import { SegBuilder } from '../util';
import { shiftPart, type Part } from './part';

/** One JSON value per line (NDJSON / JSON Lines logs). */
function isJsonLines(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.length >= 2 && lines.every((l) => /^\s*[[{].*[\]}]\s*,?\s*$/.test(l));
}

function segmentJsonLines(text: string): Part {
  const b = new SegBuilder(text.length);
  const pairs: Pair[] = [];
  let errors = 0;
  let pos = 0;
  while (pos <= text.length) {
    let e = text.indexOf('\n', pos);
    if (e < 0) e = text.length;
    const line = text.slice(pos, e);
    if (line.trim()) {
      const part = shiftPart(segmentJsonRaw(line), pos);
      for (const sg of part.segments) {
        const { start, end, scope, ...rest } = sg;
        b.add(start, end, scope, rest);
      }
      pairs.push(...part.pairs);
      errors += part.errors;
    }
    pos = e + 1;
  }
  return { segments: b.finish(), pairs, columns: [], errors };
}

/** Pasted JSON is often a fragment ("key": value, ...); wrap it in braces so it parses. */
export function segmentJson(text: string): Part {
  if (isJsonLines(text)) return segmentJsonLines(text);
  if (/^\s*[[{]/.test(text) || !text.trim()) return segmentJsonRaw(text);
  const inner = shiftPart(segmentJsonRaw('{' + text + '\n}'), -1);
  const len = text.length;
  const segments = inner.segments
    .filter((s) => s.end > 0 && s.start < len)
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(len, s.end) }));
  return { ...inner, segments, pairs: inner.pairs.filter((p) => p.valStart >= 0 && p.valEnd <= len), errors: inner.errors };
}

function segmentJsonRaw(text: string): Part {
  const b = new SegBuilder(text.length);
  const pairs: Pair[] = [];
  let errors = 0;
  interface Frame {
    arr: boolean;
    key?: string;
    keyStart: number;
    keyEnd: number;
    nameTok?: { text: string; start: number; end: number };
    valTok?: { start: number; end: number; quote: string; num: boolean };
    /** key that owns this array/object */
    owner?: string;
    ownerStart: number;
    ownerEnd: number;
  }
  const stack: Frame[] = [];
  const pathOf = () => stack.map((f) => (f.arr ? f.owner : f.key)).filter(Boolean).join('.');
  const openChild = (arr: boolean) => {
    const top = stack[stack.length - 1];
    const f: Frame = { arr, keyStart: 0, keyEnd: 0, ownerStart: 0, ownerEnd: 0 };
    if (top) {
      if (top.arr) {
        f.owner = top.owner;
        f.ownerStart = top.ownerStart;
        f.ownerEnd = top.ownerEnd;
      } else {
        f.owner = top.key;
        f.ownerStart = top.keyStart;
        f.ownerEnd = top.keyEnd;
      }
    }
    stack.push(f);
  };
  visit(
    text,
    {
      onObjectBegin: () => openChild(false),
      onObjectEnd: () => {
        const f = stack.pop();
        if (f?.nameTok && f.valTok) {
          pairs.push({ key: f.nameTok.text, keyStart: f.nameTok.start, keyEnd: f.nameTok.end, valStart: f.valTok.start, valEnd: f.valTok.end, quote: f.valTok.quote, numeric: f.valTok.num, kind: 'element', path: pathOf() });
        }
      },
      onArrayBegin: () => openChild(true),
      onArrayEnd: () => void stack.pop(),
      onObjectProperty: (property, offset, length) => {
        const top = stack[stack.length - 1];
        if (!top) return;
        top.key = property;
        top.keyStart = offset + 1;
        top.keyEnd = offset + length - 1;
        b.add(offset + 1, offset + length - 1, 'key');
      },
      onLiteralValue: (value, offset, length) => {
        const top = stack[stack.length - 1];
        const isStr = typeof value === 'string';
        const vs = isStr ? offset + 1 : offset;
        const ve = isStr ? offset + length - 1 : offset + length;
        const num = typeof value === 'number';
        if (isStr) b.add(vs, ve, 'config', { quote: '"', vt: 'str' });
        else b.add(vs, ve, 'config', { vt: num ? 'num' : 'lit' });
        if (!top) return;
        if (!top.arr && top.key) {
          const lk = top.key.toLowerCase();
          if (isStr && (lk === 'name' || lk === 'key' || lk === 'variable')) top.nameTok = { text: text.slice(vs, ve), start: vs, end: ve };
          else if (lk === 'value' || lk === 'val') top.valTok = { start: vs, end: ve, quote: isStr ? '"' : '', num };
        }
        const key = top.arr ? top.owner : top.key;
        if (!key) return;
        pairs.push({
          key,
          keyStart: top.arr ? top.ownerStart : top.keyStart,
          keyEnd: top.arr ? top.ownerEnd : top.keyEnd,
          valStart: vs,
          valEnd: ve,
          quote: isStr ? '"' : '',
          numeric: num,
          path: pathOf(),
          kind: 'kv',
        });
      },
      onComment: (offset, length) => b.add(offset, offset + length, 'comment'),
      onError: () => {
        errors++;
      },
    },
    { allowTrailingComma: true, disallowComments: false },
  );
  return { segments: b.finish(), pairs, columns: [], errors };
}
