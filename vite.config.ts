import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const sha = (s: string) => "'sha256-" + createHash('sha256').update(s).digest('base64') + "'";

/**
 * Content-Security-Policy that makes the browser refuse any request to another origin. The single
 * HTML file has inline script/style, so they are allowed by hash instead of 'unsafe-inline'.
 */
function csp(): Plugin {
  let outDir = 'dist';
  return {
    name: 'airlock-csp',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // dev server needs inline HMR scripts: no CSP there
        return ctx.server ? html.replace('<!--CSP-->', '') : html;
      },
    },
    closeBundle() {
      const file = resolve(outDir, 'airlock.html');
      let html = readFileSync(file, 'utf8');
      const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
      const policy = [
        "default-src 'none'",
        `script-src ${scripts.filter(Boolean).map(sha).join(' ') || "'none'"}`,
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

export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true }), csp()],
  worker: { format: 'iife' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: resolve(__dirname, 'airlock.html') },
  },
});
