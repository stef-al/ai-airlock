import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter';
import { assetBytes } from './assets';

let model: GraphModel | null = null;

/** BlazeFace (MediaPipe, 256x256 "back camera" model) loaded from the embedded weights. */
async function faceModel(): Promise<GraphModel> {
  if (model) return model;
  await tf.setBackend('cpu');
  const json = JSON.parse(new TextDecoder().decode(await assetBytes('faces/blazeface.json')));
  const bin = await assetBytes('faces/blazeface.bin');
  model = await loadGraphModel(
    tf.io.fromMemory({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest[0].weights,
      weightData: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer,
      format: json.format,
      generatedBy: json.generatedBy,
      convertedBy: json.convertedBy,
      userDefinedMetadata: json.userDefinedMetadata,
    }),
  );
  return model;
}

/** Spike: run the detector once and report the raw output shapes and the best score. */
export async function faceSpike(image: ImageBitmap): Promise<{ shapes: number[][]; best: number; ms: number }> {
  const m = await faceModel();
  const t0 = performance.now();
  const input = tf.tidy(() => tf.expandDims(tf.sub(tf.div(tf.cast(tf.image.resizeBilinear(tf.browser.fromPixels(image), [256, 256]), 'float32'), 127.5), 1), 0));
  const out = m.execute(input) as tf.Tensor[];
  const shapes = out.map((t) => t.shape);
  let best = -Infinity;
  for (const t of out) if (t.shape[2] === 1) best = Math.max(best, (await tf.max(t).data())[0]);
  tf.dispose([input, ...out]);
  return { shapes, best: 1 / (1 + Math.exp(-best)), ms: Math.round(performance.now() - t0) };
}
