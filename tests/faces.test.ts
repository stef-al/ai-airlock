import { describe, expect, it } from 'vitest';
import { anchors, decode, expand, merge, tilePlan, type Face } from '../src/media/facedetect';

describe('faces: BlazeFace decoding', () => {
  it('lays out 896 anchors, the fine grid first', () => {
    const a = anchors();
    expect(a).toHaveLength(896);
    expect(a[0]).toEqual({ x: 0.5 / 16, y: 0.5 / 16 });
    expect(a[1]).toEqual(a[0]); // two anchors per cell
    expect(a[2]).toEqual({ x: 1.5 / 16, y: 0.5 / 16 });
    expect(a[512]).toEqual({ x: 0.5 / 8, y: 0.5 / 8 });
    expect(a[517]).toEqual(a[512]); // six per cell on the coarse grid
  });

  it('decodes a box relative to its anchor and maps it to the tile', () => {
    const a = anchors();
    const reg = new Float32Array(896 * 16);
    const logits = new Float32Array(896).fill(-10);
    // anchor 2 is centred at (24, 8) in the 256×256 input; offset (+8, +4), size 32×40
    reg.set([8, 4, 32, 40], 2 * 16);
    logits[2] = 3;
    const faces = decode(reg, logits, a, 0.5, { x: 100, y: 50, size: 512 });
    expect(faces).toHaveLength(1);
    expect(faces[0].score).toBeCloseTo(1 / (1 + Math.exp(-3)));
    // input box [16, -8, 48, 32] scaled ×2 and moved by the tile origin
    expect(faces[0].box).toEqual([132, 34, 196, 114]);
  });
});

describe('faces: tiles and merging', () => {
  it('searches the whole image, then smaller overlapping tiles, within a budget', () => {
    const t = tilePlan(1920, 1080);
    expect(t[0]).toEqual({ x: 0, y: 0, size: 1920 });
    expect(t.length).toBeLessThanOrEqual(100);
    const smallest = Math.min(...t.map((x) => x.size));
    expect(smallest).toBeLessThan(300);
    // every point of the image is in some tile of the smallest size
    const fine = t.filter((x) => x.size === smallest);
    for (const [px, py] of [[0, 0], [1919, 1079], [960, 540], [1919, 0]]) expect(fine.some((x) => px >= x.x && px < x.x + x.size && py >= x.y && py < x.y + x.size)).toBe(true);
    // a small image is searched whole only; a very large one with larger finest tiles, within the budget
    expect(tilePlan(200, 120)).toEqual([{ x: 0, y: 0, size: 200 }]);
    const big = tilePlan(4000, 3000);
    expect(big.length).toBeLessThanOrEqual(100);
    expect(Math.min(...big.map((x) => x.size))).toBeLessThan(700); // faces from about 50 px in a 12-megapixel photo
  });

  it('merges detections of one face from several tiles into their union', () => {
    const found: Face[] = [
      { box: [100, 100, 160, 170], score: 0.9 },
      { box: [102, 98, 158, 150], score: 0.7 }, // the same face, cut at a tile edge
      { box: [400, 100, 440, 150], score: 0.8 }, // another face
      { box: [600, 100, 640, 150], score: 0.4 }, // too weak
    ];
    expect(merge(found, 0.5)).toEqual([
      { box: [100, 98, 160, 170], score: 0.9 },
      { box: [400, 100, 440, 150], score: 0.8 },
    ]);
  });

  it('adds room for hair and ears, clipped to the image', () => {
    expect(expand([100, 100, 200, 200], 1000, 1000)).toEqual([85, 65, 215, 212]);
    expect(expand([0, 10, 50, 60], 60, 70)).toEqual([0, 0, 58, 66]);
    expect(expand([100, 100, 110, 112], 1000, 1000)).toEqual([97, 95, 113, 115]); // at least 3 px
  });
});
