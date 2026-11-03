/// <reference lib="webworker" />
// BlazeFace in the media worker: TF.js with its WebAssembly backend (SIMD, one thread), started
// from embedded bytes. The backend asks the platform's fetch for its binary; that fetch answers
// from memory, so nothing is requested. The CPU backend is the fallback.
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter';
import { anchors, decode, expand, INPUT, merge, tilePlan, type Face } from './facedetect';
import type { FaceOpts } from './protocol';

export interface FaceAssets {
  model: Uint8Array;
  weights: Uint8Array;
  simd: Uint8Array;
  plain: Uint8Array;
}

let model: GraphModel | null = null;
let backend = '';
const ANCHORS = anchors();
/** detections below this are dropped before merging; faces below MIN_SCORE are not reported */
const RAW_SCORE = 0.4;
/** measured (npm run metrics:faces): every face found scored at least 0.70, false boxes rarely do */
export const MIN_SCORE = 0.7;

export async function initFaces(a: FaceAssets): Promise<string> {
  if (model) return backend;
  const platform = tf.env().platform as unknown as { fetch: (path: string, init?: unknown) => Promise<Response> };
  const original = platform.fetch.bind(platform);
  platform.fetch = (path, init) => {
    if (path.endsWith('-simd.wasm')) return Promise.resolve(new Response(a.simd as BlobPart, { headers: { 'Content-Type': 'application/wasm' } }));
    if (path.endsWith('.wasm')) return Promise.resolve(new Response(a.plain as BlobPart, { headers: { 'Content-Type': 'application/wasm' } }));
    return original(path, init);
  };
  // threads need cross-origin isolation (not available from file://)
  tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
  setWasmPaths({ 'tfjs-backend-wasm.wasm': 'embedded/tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm': 'embedded/tfjs-backend-wasm-simd.wasm', 'tfjs-backend-wasm-threaded-simd.wasm': 'embedded/tfjs-backend-wasm-threaded-simd.wasm' }, true);
  let ok = false;
  try {
    ok = await tf.setBackend('wasm');
  } catch {
    ok = false;
  }
  if (!ok) await tf.setBackend('cpu');
  await tf.ready();
  backend = tf.getBackend();
  const json = JSON.parse(new TextDecoder().decode(a.model));
  model = await loadGraphModel(
    tf.io.fromMemory({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest[0].weights,
      weightData: a.weights.buffer.slice(a.weights.byteOffset, a.weights.byteOffset + a.weights.byteLength) as ArrayBuffer,
      format: json.format,
      generatedBy: json.generatedBy,
      convertedBy: json.convertedBy,
      userDefinedMetadata: json.userDefinedMetadata,
    }),
  );
  return backend;
}

export const facesReady = () => model !== null;

/** luminance barely varies over the tile (sampled every 4th pixel of every 4th row) */
function flat(px: Uint8ClampedArray): boolean {
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (let y = 0; y < INPUT; y += 4) {
    for (let x = 0; x < INPUT; x += 4) {
      const i = (y * INPUT + x) * 4;
      const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      sum += l;
      sq += l * l;
      n++;
    }
  }
  const mean = sum / n;
  return sq / n - mean * mean < 25; // standard deviation under 5 levels
}

/** one pass of the model over 256×256 RGBA pixels */
function run(px: Uint8ClampedArray): { reg: Float32Array; logits: Float32Array } {
  const input = new Float32Array(INPUT * INPUT * 3);
  for (let i = 0, o = 0; i < px.length; i += 4, o += 3) {
    input[o] = px[i] / 127.5 - 1;
    input[o + 1] = px[i + 1] / 127.5 - 1;
    input[o + 2] = px[i + 2] / 127.5 - 1;
  }
  const t = tf.tensor4d(input, [1, INPUT, INPUT, 3]);
  const out = model!.execute(t) as tf.Tensor[];
  // outputs are told apart by shape: regressors [1, n, 16], scores [1, n, 1]; the 512-anchor grid comes first
  const pick = (n: number, d: number) => out.find((x) => x.shape[1] === n && x.shape[2] === d)!.dataSync() as Float32Array;
  const reg = new Float32Array(896 * 16);
  reg.set(pick(512, 16), 0);
  reg.set(pick(384, 16), 512 * 16);
  const logits = new Float32Array(896);
  logits.set(pick(512, 1), 0);
  logits.set(pick(384, 1), 512);
  tf.dispose([t, ...out]);
  return { reg, logits };
}

/** Faces in an image (drawn on white): every tile of the plan, merged, enlarged for redaction. */
export function detectFaces(src: OffscreenCanvas, o: FaceOpts = {}): { faces: Face[]; tiles: number; ms: number } {
  if (!model) throw new Error('the face model is not loaded');
  const t0 = performance.now();
  const w = src.width;
  const h = src.height;
  const c = new OffscreenCanvas(INPUT, INPUT);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingQuality = 'high';
  const found: Face[] = [];
  const plan = tilePlan(w, h, o.minTile, o.maxTiles);
  let skipped = 0;
  for (const tile of plan) {
    x.fillStyle = '#fff';
    x.fillRect(0, 0, INPUT, INPUT);
    // the part of the tile inside the image (a tile at the edge or the whole image is letterboxed)
    const sw = Math.min(tile.size, w - tile.x);
    const sh = Math.min(tile.size, h - tile.y);
    const k = INPUT / tile.size;
    x.drawImage(src, tile.x, tile.y, sw, sh, 0, 0, sw * k, sh * k);
    const px = x.getImageData(0, 0, INPUT, INPUT).data;
    // an even area (the empty part of a screenshot) holds no face: skip the model
    if (flat(px)) {
      skipped++;
      continue;
    }
    const { reg, logits } = run(px);
    found.push(...decode(reg, logits, ANCHORS, RAW_SCORE, tile));
  }
  const faces = merge(found, o.minScore ?? MIN_SCORE).map((f) => ({ box: expand(f.box, w, h), score: f.score }));
  return { faces, tiles: plan.length - skipped, ms: Math.round(performance.now() - t0) };
}
