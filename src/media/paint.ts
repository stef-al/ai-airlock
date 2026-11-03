// Painting redactions: opaque boxes over decoded pixels, optionally labelled with the placeholder.
// Shared by the media worker (images, OffscreenCanvas) and the page (PDF pages rendered by pdf.js).
import type { RenderBox } from './protocol';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Largest monospace size (7 px or more) at which the label fits the box, or 0. */
function fit(x: Ctx, label: string, w: number, h: number): number {
  let size = Math.floor(Math.min(h * 0.72, 40));
  for (; size >= 7; size--) {
    x.font = `bold ${size}px monospace`;
    if (x.measureText(label).width <= w - 4) return size;
  }
  return 0;
}

/** Nothing of the original survives inside a box: the fill is opaque and replaces the pixels. */
export function paintBoxes(x: Ctx, boxes: RenderBox[], labels: boolean, scale = 1): void {
  x.save();
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.fillStyle = '#000';
  for (const { box } of boxes) x.fillRect(box[0] * scale, box[1] * scale, (box[2] - box[0]) * scale, (box[3] - box[1]) * scale);
  if (labels) {
    x.fillStyle = '#fff';
    x.textBaseline = 'middle';
    for (const { box, label } of boxes) {
      if (!label) continue;
      const w = (box[2] - box[0]) * scale;
      const h = (box[3] - box[1]) * scale;
      const size = fit(x, label, w, h);
      if (!size) continue;
      x.font = `bold ${size}px monospace`;
      x.fillText(label, box[0] * scale + 2, ((box[1] + box[3]) / 2) * scale);
    }
  }
  x.restore();
}
