# BlazeFace face detector (vendored model)

Used by `src/media/faces.ts` and embedded in `dist/airlock-media.html` at build time. It is not
fetched from anywhere at runtime.

| File | SHA-256 |
|---|---|
| `blazeface-back.json` (graph-model topology and weight manifest) | `a765f7b2a6c1d841ecc0b0686e5f51b141b39b7bcdf2888542dc9d9fc4384a87` |
| `blazeface-back.bin` (weights) | `dc9a97fdc50bc43216554bdd69aa3e7b9361a519ee7bdd996a2f69a98a6f9b72` |

- **Source:** npm package `@vladmandic/human-models@3.0.4` (MIT), files `models/blazeface-back.json` and `models/blazeface-back.bin`. Copied, not installed, because the package holds about 150 MB of other models.
- **Origin:** Google MediaPipe BlazeFace, the 256×256 "back camera" model for faces further from the camera (Apache License 2.0), converted to TensorFlow.js by Vladimir Mandic.
- **Model:** input `1×256×256×3` (RGB scaled to [-1, 1]); 896 anchors in two grids, 16×16×2 and 8×8×6. Outputs are box and keypoint regressors (`1×512×16`, `1×384×16`) and scores (`1×512×1`, `1×384×1`, logits).

To update, replace both files, update the hashes above, and run `npm run build && npm run smoke`.
