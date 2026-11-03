// Face detection logic around the BlazeFace "back" model (MediaPipe, 256×256 input): anchors,
// decoding of its outputs, the tiles an image is searched in, and merging what the tiles found.
// Pure: no TF.js, no DOM (the model runs in faces.ts, in the media worker).
import type { Box } from './ocrTypes';

export const INPUT = 256;

export interface Anchor {
  x: number;
  y: number;
}

/**
 * SSD anchors of the back model: strides 16, 32, 32, 32 (layers with the same stride share a
 * grid), two anchors per layer and cell, fixed size, centred in their cell. 16×16×2 + 8×8×6 = 896.
 */
export function anchors(): Anchor[] {
  const out: Anchor[] = [];
  for (const [grid, perCell] of [
    [16, 2],
    [8, 6],
  ] as const) {
    for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) for (let k = 0; k < perCell; k++) out.push({ x: (x + 0.5) / grid, y: (y + 0.5) / grid });
  }
  return out;
}

export interface Face {
  /** [x0, y0, x1, y1] in pixels of the image */
  box: Box;
  score: number;
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-Math.max(-100, Math.min(100, v))));

/**
 * Faces in one model output: regressors (16 values per anchor: centre, size, then 6 keypoints, in
 * input pixels) and score logits, both in anchor order. Boxes are mapped from the 256×256 input
 * to the tile `tile` (square, image pixels).
 */
export function decode(regressors: Float32Array, logits: Float32Array, anchorList: Anchor[], minScore: number, tile: { x: number; y: number; size: number }): Face[] {
  const out: Face[] = [];
  const k = tile.size / INPUT;
  for (let i = 0; i < anchorList.length; i++) {
    const score = sigmoid(logits[i]);
    if (score < minScore) continue;
    const r = i * 16;
    const cx = regressors[r] + anchorList[i].x * INPUT;
    const cy = regressors[r + 1] + anchorList[i].y * INPUT;
    const w = regressors[r + 2];
    const h = regressors[r + 3];
    if (!(w > 0 && h > 0)) continue;
    out.push({ box: [tile.x + (cx - w / 2) * k, tile.y + (cy - h / 2) * k, tile.x + (cx + w / 2) * k, tile.y + (cy + h / 2) * k], score });
  }
  return out;
}

export interface Tile {
  /** top left and side of a square region of the image (it may extend past the image: letterboxed) */
  x: number;
  y: number;
  size: number;
}

/**
 * Where to look: the whole image, the finest tiles (about `minTile` px, larger when a big image
 * would need more than about 80 of them) and tiles three times as large in between, so that every
 * face size fits whole in some tile (tiles overlap by a quarter). A face of about 8% of a tile
 * (eyebrows to chin) is found, so the finest tiles set the smallest face.
 */
export function tilePlan(w: number, h: number, minTile = 200, maxTiles = 100): Tile[] {
  const max = Math.max(w, h);
  const out: Tile[] = [{ x: 0, y: 0, size: max }];
  const positions = (len: number, size: number) => {
    if (len <= size) return [0];
    const n = Math.ceil((len - size) / (size * 0.75)) + 1;
    return [...Array(n).keys()].map((i) => Math.round(((len - size) * i) / (n - 1)));
  };
  const count = (s: number) => positions(w, s).length * positions(h, s).length;
  let fine = minTile;
  while (count(Math.round(fine)) > maxTiles * 0.8 && fine < max) fine *= 1.25;
  for (let size = fine; size < max / 1.5; size *= 3) {
    const s = Math.round(size);
    if (out.length + count(s) > maxTiles) break;
    for (const y of positions(h, s)) for (const x of positions(w, s)) out.push({ x, y, size: s });
  }
  return out;
}

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
export function iou(a: Box, b: Box): number {
  const i = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  return i ? i / (area(a) + area(b) - i) : 0;
}
/** share of the smaller box inside the other (a face cut at a tile edge lies inside the whole one) */
function overlap(a: Box, b: Box): number {
  const i = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  return i ? i / Math.min(area(a), area(b)) : 0;
}

/**
 * One face per cluster of detections from overlapping tiles and scales. For redaction the cluster
 * becomes the union of its boxes (a face cut at a tile edge only adds to the whole one) and keeps
 * its best score; a cluster seen by more tiles is more certain.
 */
export function merge(found: Face[], minScore: number): Face[] {
  const sorted = [...found].sort((a, b) => b.score - a.score);
  const used = new Array<boolean>(sorted.length).fill(false);
  const out: Face[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const top = sorted[i];
    const box: Box = [...top.box];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      const b = sorted[j].box;
      if (iou(top.box, b) < 0.3 && overlap(top.box, b) < 0.7) continue;
      used[j] = true;
      // a much larger box around a small face is another detection (a crowd at a coarse scale): not merged in
      if (area(b) > 4 * area(top.box)) continue;
      box[0] = Math.min(box[0], b[0]);
      box[1] = Math.min(box[1], b[1]);
      box[2] = Math.max(box[2], b[2]);
      box[3] = Math.max(box[3], b[3]);
    }
    if (top.score >= minScore) out.push({ box, score: top.score });
  }
  return out;
}

/** BlazeFace boxes cover eyebrows to chin: wider for ears and taller for hair, clipped to the image. */
export function expand(b: Box, w: number, h: number): Box {
  const bw = b[2] - b[0];
  const bh = b[3] - b[1];
  // at least 3 px around a small face (its box is less exact)
  const m = (v: number) => Math.max(3, v);
  return [Math.max(0, Math.floor(b[0] - m(bw * 0.15))), Math.max(0, Math.floor(b[1] - m(bh * 0.35))), Math.min(w, Math.ceil(b[2] + m(bw * 0.15))), Math.min(h, Math.ceil(b[3] + m(bh * 0.12)))];
}
