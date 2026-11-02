// Media build smoke test in a real browser, opening dist/airlock-media.html from disk (file://).
// Inputs are generated here (screenshots, PDF), so no realistic secret is ever committed.
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] }).catch(() => chromium.launch({ args: ['--no-sandbox'] }));
const fail = async (m) => {
  await browser.close();
  console.error('smoke-media FAILED: ' + m);
  process.exit(1);
};

const secret = ['Kv7', 'mQ2', 'wZ9', 'pL4'].join('');
const gen = await browser.newPage({ viewport: { width: 760, height: 170 } });
await gen.setContent(`<body style="margin:14px;font:16px Arial">DB_PASSWORD=${secret}<br>mail ops@acme.io or call +1 415 555 0134</body>`);
const png = (await gen.screenshot()).toString('base64');
await gen.setContent(`<body style="font:14px Arial"><h1>Invoice 2024-117</h1><p>Contact jane.doe@acme.io for questions.</p><p>api_token = ${secret}</p></body>`);
const pdf = (await gen.pdf({ format: 'A4' })).toString('base64');
await gen.close();

const page = await browser.newPage();
const problems = [];
const requests = [];
const watch = (src) => (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${src} ${m.type()}: ${m.text()}`);
page.on('console', watch('page'));
page.on('worker', (w) => w.on('console', watch('worker')));
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('request', (r) => requests.push(r.url()));

const t0 = Date.now();
await page.goto('file://' + resolve('dist/airlock-media.html'));
await page.waitForFunction(() => !!globalThis.__airlockSpike, null, { timeout: 30000 });
const loadMs = Date.now() - t0;
const spike = (fn, ...args) => page.evaluate(([f, a]) => globalThis.__airlockSpike[f](...a), [fn, args]);

const ocr = await spike('ocr', png);
if (!ocr.text.includes(secret) || !/ops@acme\.io/.test(ocr.text)) await fail('OCR did not read the screenshot: ' + JSON.stringify(ocr.text));
if (!ocr.firstChars?.length || ocr.firstChars[0].box.length !== 4) await fail('OCR returned no character boxes');
const all = await spike('ocr', png, ['eng', 'deu', 'fra', 'spa', 'ita', 'pol', 'ces']);
if (!all.text.includes(secret)) await fail('OCR with all languages failed: ' + JSON.stringify(all.text));
const p = await spike('pdf', pdf);
if (!p.text.includes(secret) || !p.ocr.includes(secret)) await fail('PDF text layer or OCR of the rendered page failed: ' + JSON.stringify(p));
const f = await spike('faces', png);
if (JSON.stringify(f.shapes.map((s) => s.join('x')).sort()) !== JSON.stringify(['1x384x1', '1x384x16', '1x512x1', '1x512x16'])) await fail('face model outputs: ' + JSON.stringify(f));

const external = requests.filter((u) => !u.startsWith('file:') && !u.startsWith('blob:') && !u.startsWith('data:'));
if (external.length) await fail('network requests: ' + external.join(', '));
const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => 'LEAK', () => 'blocked'));
if (blocked !== 'blocked') await fail('fetch was not blocked by CSP');
// workers inherit the policy: a worker cannot reach the network either
const inWorker = await page.evaluate(
  () =>
    new Promise((res) => {
      const w = new Worker(URL.createObjectURL(new Blob(["fetch('https://example.com/').then(() => postMessage('LEAK'), () => postMessage('blocked'))"], { type: 'text/javascript' })));
      w.onmessage = (e) => res(e.data);
      setTimeout(() => res('timeout'), 5000);
    }),
);
if (inWorker !== 'blocked') await fail('fetch from a worker was not blocked: ' + inWorker);
// the only expected entry is the refusal of the deliberate request above
const unexpected = problems.filter((x) => !/https:\/\/example\.com\/.*(?:Refused to connect|Content Security Policy)|Refused to connect to 'https:\/\/example\.com/.test(x));
if (unexpected.length) await fail('console problems (CSP violations show here):\n' + unexpected.join('\n'));

console.log(`smoke-media OK: load ${loadMs} ms | OCR eng ${ocr.ms} ms, 7 languages ${all.ms} ms | PDF page + OCR ${p.ms} ms | face model ${f.ms} ms | no requests, no CSP violations, fetch blocked in page and workers`);
await browser.close();
