// Media build smoke test in a real browser, opening dist/airlock-media.html from disk (file://).
// Inputs are generated here (screenshots, a QR code, metadata), so nothing realistic is committed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { chromium } from 'playwright-core';
import QRCode from 'qrcode';

const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] }).catch(() => chromium.launch({ args: ['--no-sandbox'] }));
const fail = async (m) => {
  await browser.close();
  console.error('smoke-media FAILED: ' + m);
  process.exit(1);
};
const FILE = 'file://' + resolve('dist/airlock-media.html');

// ---------------------------------------------------------------------------------------------
// inputs
const secret = ['Kv7', 'mQ2', 'wZ9', 'pL4'].join('');
const otp = ['JBSW', 'Y3DP', 'EHPK', '3PXP'].join('');
const qr = await QRCode.toDataURL(`otpauth://totp/Acme:ops?secret=${otp}&issuer=Acme`, { margin: 2, scale: 4 });
const gen = await browser.newPage({ viewport: { width: 860, height: 300 } });
await gen.setContent(`<body style="margin:16px;font:15px Arial">
  <div>Deploy notes: mail ops@acme.io or call +1 415 555 0134</div>
  <pre style="font:14px monospace">DB_PASSWORD=${secret}</pre>
  <img src="${qr}" style="position:absolute;right:24px;top:40px"></body>`);
let png = await gen.screenshot();
// a PNG text chunk (author) and, below, EXIF with a GPS location in a JPEG
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const iend = png.lastIndexOf(Buffer.from('IEND', 'latin1')) - 4;
png = Buffer.concat([png.subarray(0, iend), chunk('tEXt', Buffer.from('Author\0Jane Example', 'latin1')), png.subarray(iend)]);
await gen.setContent(`<body style="margin:16px;font:16px Georgia;background:#f4f1ea">Customer card 4539 5787 6362 1486, contact jane.doe@acme.io</body>`);
let jpeg = await gen.screenshot({ type: 'jpeg', quality: 90 });
const le16 = (n) => [n & 255, n >> 8];
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
const tiff = Buffer.from([...Buffer.from('II'), ...le16(42), ...le32(8), ...le16(1), ...le16(0x8825), ...le16(4), ...le32(1), ...le32(26), ...le32(0), ...le16(0), ...le32(0)]);
const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
const app1Len = Buffer.from([(app1.length + 2) >> 8, (app1.length + 2) & 255]);
jpeg = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), app1Len, app1, jpeg.subarray(2)]);
await gen.setContent(`<body style="margin:12px;font:15px Arial">token = ${secret} for the backup job</body>`);
const embedded = (await gen.screenshot({ clip: { x: 0, y: 0, width: 520, height: 44 } })).toString('base64');
await gen.close();

// ---------------------------------------------------------------------------------------------
// the app
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1360, height: 1000 } });
const problems = [];
const requests = [];
const watch = (src) => (m) => ['error', 'warning'].includes(m.type()) && problems.push(`${src} ${m.type()}: ${m.text()}`);
page.on('console', watch('page'));
page.on('worker', (w) => w.on('console', watch('worker')));
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('request', (r) => requests.push(r.url()));
await page.goto(FILE);
await page.locator('input[type=file][multiple]').setInputFiles([
  { name: 'notes.png', mimeType: 'image/png', buffer: png },
  { name: 'card.jpg', mimeType: 'image/jpeg', buffer: jpeg },
]);

const done = async (name) => {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForFunction(() => {
    const box = document.querySelector('.reviewed input');
    return !!document.querySelector('canvas[aria-label="redacted copy"]:not(.stale)') && box && !box.disabled;
  }, null, { timeout: 90000 });
  return page.locator('.findings tbody').innerText();
};
const report = () => page.locator('ul.report').innerText();
const download = async (label) => {
  await page.locator('.reviewed input').check();
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download', exact: true }).click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()), label };
};

const f1 = await done('notes.png');
for (const t of ['PASSWORD', 'EMAIL', 'PHONE', 'QR']) if (!f1.includes(t)) await fail(`notes.png: no ${t} finding:\n${f1}`);
const r1 = await report();
if (!/PNG text: Author/.test(r1) || !/QR code covered/.test(r1) || !/no masked value is readable/.test(r1)) await fail('notes.png report:\n' + r1);
const out1 = await download('png');
const f2 = await done('card.jpg');
if (!f2.includes('CARD') || !f2.includes('EMAIL')) await fail('card.jpg findings:\n' + f2);
if (!/EXIF: GPS location/.test(await report())) await fail('card.jpg: GPS metadata not reported');
const out2 = await download('jpeg');
if (out1.name !== 'notes-redacted.png' || out2.name !== 'card-redacted.jpg') await fail(`download names ${out1.name}, ${out2.name}`);
// no metadata in the copies: no PNG text/EXIF chunks, no JPEG APP1 segment
if (/tEXt|zTXt|iTXt|eXIf/.test(out1.bytes.toString('latin1'))) await fail('metadata chunk left in the PNG copy');
if (out2.bytes.includes(Buffer.from('Exif\0\0', 'latin1')) || out2.bytes.includes(Buffer.from([0xff, 0xe1]))) await fail('EXIF left in the JPEG copy');

// a pasted screenshot becomes an image document
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
}, embedded);
if (!/TOKEN|PASSWORD/.test(await done('pasted image 1.png'))) await fail('pasted screenshot: no secret found');

// an image embedded in pasted Markdown becomes an image of its own; the text keeps IMAGE_n until reviewed
await page.getByRole('button', { name: '+ paste' }).click();
await page.getByLabel('Text to mask').fill(`Backup job screenshot:\n\n![job](data:image/png;base64,${embedded})\n`);
await page.waitForSelector('.out mark.ph', { timeout: 30000 });
if (!(await page.locator('.out').innerText()).includes('base64,IMAGE_1')) await fail('embedded image not masked in the text');
if (!/TOKEN|PASSWORD/.test(await done('pasted text › image 1'))) await fail('embedded image: no secret found');

// the copies: OCR (in the self-test page) must not read the masked values any more
const check = await browser.newPage();
await check.goto(FILE + '#selftest');
await check.waitForFunction(() => !!globalThis.__airlockSelfTest, null, { timeout: 30000 });
for (const o of [out1, out2]) {
  const text = await check.evaluate((b) => globalThis.__airlockSelfTest.readText(b), o.bytes.toString('base64'));
  if (text.includes(secret) || /4539 ?5787|ops@acme|jane\.doe/.test(text)) await fail(`${o.label} copy still shows a masked value:\n${text}`);
}
// pdf.js and the face model still load from memory (used by later phases)
const pdfGen = await browser.newPage();
await pdfGen.setContent(`<body style="font:14px Arial"><h1>Invoice</h1><p>api_token = ${secret}</p></body>`);
const pdf = (await pdfGen.pdf({ format: 'A4' })).toString('base64');
const p = await check.evaluate((b) => globalThis.__airlockSelfTest.pdf(b), pdf);
if (!p.text.includes(secret)) await fail('PDF text layer: ' + JSON.stringify(p.text));
const fm = await check.evaluate((b) => globalThis.__airlockSelfTest.faces(b), embedded);
if (fm.shapes.length !== 4) await fail('face model outputs: ' + JSON.stringify(fm));

// restore puts back what a box label stands for
await page.getByRole('tab', { name: /Restore/ }).click();
await page.getByLabel('AI reply').fill('Rotate [PASSWORD_1] and the code behind [QR_1].');
await page.waitForFunction(() => (document.querySelector('.out')?.textContent ?? '').startsWith('Rotate'), null, { timeout: 8000 });
const restored = await page.locator('.out').innerText();
if (!restored.includes('otpauth://') || /\[(?:PASSWORD|QR)_1\]/.test(restored)) await fail('restore of box labels: ' + restored);

const external = [...requests].filter((u) => !u.startsWith('file:') && !u.startsWith('blob:') && !u.startsWith('data:'));
if (external.length) await fail('network requests: ' + external.join(', '));
const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => 'LEAK', () => 'blocked'));
if (blocked !== 'blocked') await fail('fetch was not blocked by CSP');
const inWorker = await page.evaluate(
  () =>
    new Promise((res) => {
      const w = new Worker(URL.createObjectURL(new Blob(["fetch('https://example.com/').then(() => postMessage('LEAK'), () => postMessage('blocked'))"], { type: 'text/javascript' })));
      w.onmessage = (e) => res(e.data);
      setTimeout(() => res('timeout'), 5000);
    }),
);
if (inWorker !== 'blocked') await fail('fetch from a worker was not blocked: ' + inWorker);
const unexpected = problems.filter((x) => !/https:\/\/example\.com\/.*(?:Refused to connect|Content Security Policy)|Refused to connect to 'https:\/\/example\.com/.test(x));
if (unexpected.length) await fail('console problems (CSP violations show here):\n' + unexpected.join('\n'));

console.log('smoke-media OK: PNG (text chunk, QR) and JPEG (EXIF GPS) redacted without metadata, nothing readable | pasted screenshot | embedded image | restore of box labels | PDF + face model load | no requests, no CSP violations');
await browser.close();
