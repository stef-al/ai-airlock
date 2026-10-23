import type { Column, Doc, Pair, Segment } from '../types';

/** Result of a segmenter before it is wrapped into a Doc. */
export interface Part {
  segments: Segment[];
  pairs: Pair[];
  columns: Column[];
  errors: number;
}

export function emptyPart(): Part {
  return { segments: [], pairs: [], columns: [], errors: 0 };
}

/** Shift a part computed on a slice so its offsets are absolute. */
export function shiftPart(p: Part, off: number): Part {
  if (!off) return p;
  return {
    segments: p.segments.map((s) => ({ ...s, start: s.start + off, end: s.end + off })),
    pairs: p.pairs.map((x) => ({
      ...x,
      keyStart: x.keyStart + off,
      keyEnd: x.keyEnd + off,
      valStart: x.valStart + off,
      valEnd: x.valEnd + off,
    })),
    columns: p.columns.map((c) => ({
      ...c,
      headerStart: c.headerStart + off,
      headerEnd: c.headerEnd + off,
      cells: c.cells.map((x) => ({ start: x.start + off, end: x.end + off })),
    })),
    errors: p.errors,
  };
}

export function proseSegments(len: number, scope: 'prose' | 'string' | 'config' = 'prose'): Segment[] {
  return len ? [{ start: 0, end: len, scope }] : [];
}

export type { Doc };
