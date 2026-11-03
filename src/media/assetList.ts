// Binary assets of airlock-media.html. The build embeds each one as an inert data block
// (<script type="application/octet-stream" id="asset:NAME">base64</script>, see vite.config.ts);
// assetBytes() in assets.ts reads them back. Nothing is ever fetched.

export const OCR_LANGS = ['eng', 'deu', 'fra', 'spa', 'ita', 'pol', 'ces'] as const;
export type OcrLang = (typeof OCR_LANGS)[number];

/** asset name → file, relative to the project root */
export const MEDIA_FILES: Record<string, string> = {
  'tess/core.wasm': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm',
  ...Object.fromEntries(OCR_LANGS.map((l) => [`tess/${l}.traineddata.gz`, `node_modules/@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`])),
  'faces/blazeface.json': 'vendor/blazeface/blazeface-back.json',
  'faces/blazeface.bin': 'vendor/blazeface/blazeface-back.bin',
  // TF.js WebAssembly backend (SIMD build, and the plain one for browsers without SIMD)
  'faces/tfjs-simd.wasm': 'node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm',
  'faces/tfjs.wasm': 'node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm',
};

/** every file of `dir` that matches is embedded as `prefix + file name` */
export const MEDIA_DIRS: { prefix: string; dir: string; match: RegExp }[] = [
  { prefix: 'pdf/fonts/', dir: 'node_modules/pdfjs-dist/standard_fonts/', match: /\.(?:pfb|ttf)$/ },
  // image decoders (JBIG2 scans, JPEG 2000) and colour management; quickjs (PDF scripting) is left out
  { prefix: 'pdf/wasm/', dir: 'node_modules/pdfjs-dist/wasm/', match: /^(?:openjpeg|jbig2|qcms_bg)\.wasm$/ },
];

/** Where the dev server (no CSP) finds an asset. */
export function assetPath(name: string): string | null {
  if (MEDIA_FILES[name]) return MEDIA_FILES[name];
  const d = MEDIA_DIRS.find((x) => name.startsWith(x.prefix));
  return d ? d.dir + name.slice(d.prefix.length) : null;
}
