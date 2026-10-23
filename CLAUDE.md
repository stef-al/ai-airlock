# AI Airlock: working notes

Offline, browser-only masking of secrets/PII before pasting into AI chatbots, and restoring them in the reply.
Deliverable: ONE file, `dist/airlock.html` (Vite + vite-plugin-singlefile, strict hash-based CSP, inline Web Worker).

## Commands
- `npm test`: vitest (unit tests + corpus: structure guard OK and mask→restore byte-identical on every fixture)
- `npm run metrics [-- --details --set=dev|holdout --strict]`: precision/recall per category/detector/type on `tests/corpus`
- `npm run build`: typecheck, bundle, then `scripts/check-dist.mjs` (single file, CSP, no network primitives)
- `npm run smoke`: real Chromium opens `dist/airlock.html` from file:// (needs `npm run build` first)
- `npm run dev`: dev server (no CSP)

## Architecture (`src/`)
- `engine/` pure TS, no DOM, runs in Node. Pipeline: `segment → detect → resolve → placeholders → guard`.
  - `segment/`: turn text into a `Doc`: segments that tile the text with a scope (prose, comment, string, config, identifier, key, structure) plus key/value `pairs` and table `columns`. json (jsonc-parser), yaml (yaml), xml/csv/env/ini/markdown (own offset-aware scanners), code lexer for js/ts/python/java/csharp/go/php/sql/bash/powershell (`code.ts`), `index.ts` sniffs the format.
  - `detectors/*`: each exports a `Detector`. `cues.ts` = secret-name analysis (multilingual cue words, qualifiers, value verdicts).
  - `resolve.ts`: scope filter, allowlist, confidence floor, overlap resolution (priority 4 user lists > 3 known/validated formats > 2 context > 1 heuristics; a longer hit containing lower ones wins).
  - `placeholders.ts`: `Mapping` (memory only, identity = exact original string) and context-safe rendering. `mask.ts` applies it, `guard.ts` re-segments the output and compares the skeleton; culprits get a safer placeholder or are skipped and flagged.
  - `restore.ts`: tolerant restore + report. `settings.ts`: defaults, presets, profile (de)serialisation.
- `worker/`: thin wrapper (`engine.worker.ts`, imported with `?worker&inline`). Cancel = terminate and respawn (`ui/engineClient.ts`).
- `ui/`: React. Imports only `engine/light.ts` (no detectors) so the main bundle stays small. No inline styles (CSP).
- `tests/corpus/*.fixture`: labelled inputs. `⟦TYPE:text⟧` marks expected spans, `{{aws:1}}` style macros expand to test-time generated tokens (`tests/tokens.ts`) so no realistic secret is ever committed. `#! set: holdout` fixtures were written before tuning.

## Detector interface (`engine/types.ts`)
```ts
interface Detector { id; label; category; types: string[]; defaultScopes: Scope[];
  detect(doc: Doc, cfg: DetectorConfig, ctx: RunCtx): Hit[] }   // pure, linear time
interface Hit { start; end; detector; type; category; confidence; reason; priority }
```
Add a detector: write it in `engine/detectors/`, add it to `BASE_DETECTORS` (engine/index.ts) and to `DETECTOR_META` (engine/meta.ts; a test keeps both in sync), add fixtures. Hits are filtered to the detector's enabled scopes by `resolve.ts`, so detectors never need to care about structure.

## Rules of the road
- Never change structure: keys, tags, identifiers, CSV headers stay out of reach unless the user enables the `identifier`/`key` scope; placeholders must be valid where they land (`hostOf` + `candidatesFor`).
- Regexes must be linear (bounded quantifiers, lookbehind anchors); `tests/engine.test.ts` throws hostile input at every detector.
- Never commit realistic secrets in tests; use macros.
