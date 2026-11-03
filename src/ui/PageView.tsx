import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Box } from '../media/ocrTypes';

export interface Mark {
  key: string;
  category: string;
  kept: boolean;
  low: boolean;
  boxes: Box[];
}

interface Props {
  bmp: ImageBitmap | null;
  /** size of the coordinate space of the boxes (image pixels, or page points for a PDF) */
  w: number;
  h: number;
  marks: Mark[];
  /** boxes the user drew */
  manual: Box[];
  sel: string | null;
  onSelect(key: string | null): void;
  onBox(box: Box): void;
  label: string;
}

/** what a box drawn by hand stands for (AREA is unlabelled) */
export const BOX_TYPES: [string, string][] = [
  ['AREA', 'area'],
  ['FACE', 'face'],
  ['SIGNATURE', 'signature'],
];

export const COLORS: Record<string, string> = { secret: '#dc2626', personal: '#2563eb', financial: '#9333ea', network: '#059669', custom: '#d97706' };

const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
const inside = (b: Box, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/** Decoded image for a canvas; the previous bitmap is released when the bytes change. */
export function useBitmap(bytes?: Uint8Array): ImageBitmap | null {
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    if (!bytes) {
      setBmp(null);
      return;
    }
    let alive = true;
    let made: ImageBitmap | null = null;
    const blob = new Blob([bytes as BlobPart]);
    createImageBitmap(blob, { imageOrientation: 'from-image' })
      .catch(() => createImageBitmap(blob))
      .then((b) => {
        if (alive) setBmp((made = b));
        else b.close();
      })
      .catch(() => setBmp(null));
    return () => {
      alive = false;
      made?.close();
    };
  }, [bytes]);
  return bmp;
}

/** The original with findings outlined; drag to cover an area, click a box to select its finding. */
export function PageView({ bmp, w, h, marks, manual, sel, onSelect, onBox, label }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const f = bmp && w ? bmp.width / w : 1;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !bmp) return;
    c.width = bmp.width;
    c.height = bmp.height;
    const x = c.getContext('2d')!;
    try {
      x.drawImage(bmp, 0, 0);
    } catch {
      return; // released while a new image is being decoded
    }
    const r = (b: Box): [number, number, number, number] => [b[0] * f, b[1] * f, (b[2] - b[0]) * f, (b[3] - b[1]) * f];
    const lw = Math.max(2, Math.round(Math.max(bmp.width, bmp.height) / 700));
    for (const m of marks) {
      const color = COLORS[m.category] ?? COLORS.custom;
      for (const b of m.boxes) {
        if (!m.kept) {
          x.fillStyle = color + '40';
          x.fillRect(...r(b));
        }
        x.setLineDash(m.kept ? [lw * 3, lw * 2] : m.low ? [lw, lw] : []);
        x.lineWidth = m.key === sel ? lw * 3 : lw;
        x.strokeStyle = color;
        x.strokeRect(...r(b));
      }
    }
    x.setLineDash([]);
    for (const b of manual) {
      x.fillStyle = 'rgba(0,0,0,0.6)';
      x.fillRect(...r(b));
    }
    if (drag) {
      x.setLineDash([lw * 2, lw * 2]);
      x.lineWidth = lw;
      x.strokeStyle = '#111';
      x.strokeRect(...r(drag));
      x.setLineDash([]);
    }
  }, [bmp, f, marks, sel, manual, drag]);

  /** pointer position in box units */
  const at = (e: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const c = e.currentTarget;
    const rc = c.getBoundingClientRect();
    return [((e.clientX - rc.left) * c.width) / rc.width / f, ((e.clientY - rc.top) * c.height) / rc.height / f];
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = at(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag([x, y, x, y]);
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const [x, y] = at(e);
    setDrag([drag[0], drag[1], x, y]);
  };
  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const [x, y] = at(e);
    setDrag(null);
    const b: Box = [Math.min(drag[0], x), Math.min(drag[1], y), Math.max(drag[0], x), Math.max(drag[1], y)];
    const min = Math.max(6 / f, w / 150);
    if (b[2] - b[0] > min && b[3] - b[1] > min) {
      onBox([Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])), Math.min(w, Math.ceil(b[2])), Math.min(h, Math.ceil(b[3]))]);
      return;
    }
    // a click: the smallest finding under the pointer
    const under = marks.filter((m) => m.boxes.some((bb) => inside(bb, x, y))).sort((a, b2) => area(a.boxes[0]) - area(b2.boxes[0]));
    onSelect(under[0] ? (under[0].key === sel ? null : under[0].key) : null);
  };

  return bmp ? <canvas ref={canvas} className="imgcanvas" aria-label={label} onPointerDown={down} onPointerMove={move} onPointerUp={up} /> : <div className="muted small">Rendering…</div>;
}

/** A finished copy (redacted image or page). */
export function CopyView({ bmp, stale, label }: { bmp: ImageBitmap | null; stale: boolean; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !bmp) return;
    c.width = bmp.width;
    c.height = bmp.height;
    try {
      c.getContext('2d')!.drawImage(bmp, 0, 0);
    } catch {
      /* released while the next copy is being decoded */
    }
  }, [bmp]);
  return <canvas ref={canvas} className={stale ? 'imgcanvas stale' : 'imgcanvas'} aria-label={label} />;
}
