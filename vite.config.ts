import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { MEDIA_DIRS, MEDIA_FILES } from './src/media/assetList.ts';

const sha = (s: string) => "'sha256-" + createHash('sha256').update(s).digest('base64') + "'";

/**
 * Network primitives our own code must never contain. `fetch` counts as a call of the global
 * function, not as a method of that name (pdf.js wants a data factory with a fetch() method).
 */
const NETWORK: [string, RegExp][] = [
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['sendBeacon', /sendBeacon/],
  ['EventSource', /EventSource/],
  ['importScripts', /importScripts\s*\(/],
  ['fetch', /(?<![.\w$])fetch\s*\((?![^()]*\)\s*\{)/],
];
/**
 * Pinned libraries with dead network code paths (loading by URL, which we never use). The CSP
 * (connect-src 'none') blocks them anyway, and the media smoke test proves no request is made.
 */
const VENDOR = /node_modules[\\/](?:pdfjs-dist|tesseract\.js-core|@tensorflow)[\\/]/;

/** Fails the build if app code (main thread or any worker) contains a network primitive. */
function scanAppCode(): Plugin {
  return {
    name: 'airlock-scan',
    apply: 'build',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const [id, m] of Object.entries(chunk.modules)) {
          // an inline worker's wrapper holds the whole worker bundle as a string; the worker build
          // itself is scanned module by module (worker.plugins below)
          if (VENDOR.test(id) || /\?worker&inline$/.test(id)) continue;
          for (const [name, re] of NETWORK) if (m.code && re.test(m.code)) this.error(`network primitive ${name} in ${id}`);
        }
      }
    },
  };
}

/** Embedded binaries of the media build: inert data blocks the browser never executes. */
function dataBlocks(root: string): string {
  const out: string[] = [];
  const add = (name: string, path: string) => out.push(`<script type="application/octet-stream" id="asset:${name}">${readFileSync(resolve(root, path)).toString('base64')}</script>`);
  for (const [name, path] of Object.entries(MEDIA_FILES)) add(name, path);
  for (const d of MEDIA_DIRS) for (const f of readdirSync(resolve(root, d.dir)).filter((x) => d.match.test(x)).sort()) add(d.prefix + f, d.dir + f);
  return out.join('\n');
}

/**
 * Content-Security-Policy that makes the browser refuse any request to another origin. The single
 * HTML file has inline script/style, so they are allowed by hash instead of 'unsafe-inline'. The
 * media file also allows WebAssembly compilation ('wasm-unsafe-eval'; JavaScript eval stays blocked).
 */
function csp(entry: string, media: boolean): Plugin {
  let outDir = 'dist';
  let root = '.';
  return {
    name: 'airlock-csp',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
      root = c.root;
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // dev server needs inline HMR scripts: no CSP there
        return ctx.server ? html.replace('<!--CSP-->', '') : html;
      },
    },
    closeBundle() {
      const file = resolve(outDir, entry);
      // also called after a failed build: let the original error show
      if (!existsSync(file)) return;
      let html = readFileSync(file, 'utf8');
      if (media) html = html.replace('</body>', dataBlocks(root) + '\n</body>');
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type="application\/octet-stream"/.test(m[1])).map((m) => m[2]);
      const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
      const scriptSrc = scripts.filter(Boolean).map(sha).join(' ') || "'none'";
      const policy = [
        "default-src 'none'",
        `script-src ${scriptSrc}${media ? " 'wasm-unsafe-eval'" : ''}`,
        `style-src ${styles.filter(Boolean).map(sha).join(' ') || "'none'"}`,
        'worker-src blob:',
        // Safari < 15.5 ignores worker-src and checks child-src; frames stay blocked by frame-src
        'child-src blob:',
        'img-src data:',
        "connect-src 'none'",
        "font-src 'none'",
        "media-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      html = html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      writeFileSync(file, html);
    },
  };
}

// `vite build` → dist/airlock.html (text only); `vite build --mode media` → dist/airlock-media.html
export default defineConfig(({ mode }) => {
  const media = mode === 'media';
  const entry = media ? 'airlock-media.html' : 'airlock.html';
  return {
    plugins: [react(), viteSingleFile({ removeViteModuleLoader: true }), scanAppCode(), csp(entry, media)],
    worker: { format: 'iife', plugins: () => [scanAppCode()] },
    build: {
      target: 'es2022',
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      modulePreload: false,
      chunkSizeWarningLimit: media ? 40_000 : 4000,
      // the lean build runs first and clears dist/; the media build adds its file
      emptyOutDir: !media,
      rollupOptions: { input: resolve(import.meta.dirname, entry) },
    },
  };
});
