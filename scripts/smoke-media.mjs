// Media build smoke test in a real browser, opening dist/airlock-media.html from disk (file://).
// Inputs are generated here (screenshots, a QR code, metadata), so nothing realistic is committed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { unzipSync, zipSync } from 'fflate';
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
// PDFs: a text PDF (title, link, a screenshot holding a password, two pages) and a scanned one
const apiToken = ['q7Zx', '9Lm2', 'Vb8T', 'r4Wk'].join('');
const adminPw = ['Hx4', '!rT', '8vQ', '2'].join('');
const dbPw = ['Wq3', 'Lz8', 'Np5', 'Rt'].join('');
await gen.setContent(`<body style="margin:12px;font:16px Arial">password: ${adminPw} (backup admin)</body>`);
const inPdf = (await gen.screenshot({ clip: { x: 0, y: 0, width: 560, height: 46 } })).toString('base64');
await gen.setViewportSize({ width: 800, height: 260 });
await gen.setContent(`<body style="margin:24px;font:18px Arial;background:#fff"><p>Employee record</p><pre style="font:17px monospace">DB_PASSWORD=${dbPw}\nmail: jane.doe@acme.io</pre></body>`);
const scanShot = (await gen.screenshot()).toString('base64');
await gen.setContent(`<html><head><title>Quarterly Ops Review</title></head><body style="font:14px Arial">
  <h1>Ops review</h1><p>Contact ops@acme.io about the rollout.</p><p>api_token = ${apiToken}</p>
  <p><a href="https://wiki.corp.local/ops">runbook</a></p><img src="data:image/png;base64,${inPdf}">
  <div style="break-before:page"><h2>Page two</h2><p>Again: api_token ${apiToken}, call +1 415 555 0134.</p></div></body></html>`);
const textPdf = await gen.pdf({ format: 'A4' });
await gen.setContent(`<body style="margin:0"><img src="data:image/png;base64,${scanShot}" style="width:100%"></body>`);
const scanPdf = await gen.pdf({ format: 'A4' });
await gen.setViewportSize({ width: 600, height: 60 });
await gen.setContent(`<body style="margin:12px;font:16px Arial">password: ${dbPw} (staging)</body>`);
const docShot = await gen.screenshot({ clip: { x: 0, y: 0, width: 520, height: 46 } });
await gen.close();

/** A one-page PDF encrypted with the standard security handler (RC4, 40 bits, revision 2). */
function lockedPdf(line, password) {
  const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
  const pad = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
  const md5 = (...b) => createHash('md5').update(Buffer.concat(b)).digest();
  const rc4 = (key, data) => {
    const S = [...Array(256).keys()];
    for (let i = 0, j = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 255;
      [S[i], S[j]] = [S[j], S[i]];
    }
    const out = Buffer.alloc(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 255;
      j = (j + S[i]) & 255;
      [S[i], S[j]] = [S[j], S[i]];
      out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
    }
    return out;
  };
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const O = rc4(md5(pad('owner-' + password)).subarray(0, 5), pad(password));
  const P = Buffer.alloc(4);
  P.writeInt32LE(-4);
  const key = md5(pad(password), O, P, id).subarray(0, 5);
  const U = rc4(key, PAD);
  const content = rc4(md5(key, Buffer.from([4, 0, 0, 0, 0])).subarray(0, 10), Buffer.from(`BT /F1 16 Tf 72 720 Td (${line}) Tj ET`, 'latin1'));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P -4 >>`,
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let size = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(size);
    parts.push(b);
    size += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${size}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref + trailer, 'latin1')]);
}
/** a small DOCX: a value split over runs, a picture, a comment, the author in the properties */
function docx(paras, picture, author, comment) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const p = (runs) => `<w:p>${[runs].flat().map((t) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`).join('')}</w:p>`;
  const img = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="4572000" cy="400000"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="shot.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="${P}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${esc(author)}</dc:creator></cp:coreProperties>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${P}"><Relationship Id="rIdImg" Type="${R}/image" Target="media/image1.png"/><Relationship Id="rIdC" Type="${R}/comments" Target="comments.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${paras.map(p).join('')}${img}</w:body></w:document>`,
    'word/comments.xml': `<?xml version="1.0" encoding="UTF-8"?><w:comments ${W}><w:comment w:id="0" w:author="${esc(author)}" w:initials="JE">${p([comment])}</w:comment></w:comments>`,
  };
  const enc = new TextEncoder();
  return Buffer.from(zipSync({ ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])), 'word/media/image1.png': new Uint8Array(picture) }));
}
const docToken = ['Hq3', 'Rt8', 'Wn2', 'Lp5', 'Zx7'].join('');
const lockedPw = ['Vq8', 'Ns3', 'Kd5'].join('');
const locked = lockedPdf(`password: ${lockedPw}`, 'open-sesame');

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

// PDFs: findings in the text layer and inside an embedded screenshot; an image-only copy
await page.locator('input[type=file][multiple]').setInputFiles([
  { name: 'review.pdf', mimeType: 'application/pdf', buffer: textPdf },
  { name: 'scan.pdf', mimeType: 'application/pdf', buffer: scanPdf },
]);
const pdfDone = async (name) => {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForFunction(() => {
    const box = document.querySelector('.reviewed input');
    return !!document.querySelector('canvas[aria-label^="redacted copy of page"]:not(.stale)') && box && !box.disabled;
  }, null, { timeout: 240000 });
  return page.locator('.findings tbody').innerText();
};
const pdfDownload = async (label) => {
  await page.locator('.reviewed input').check();
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF', exact: true }).click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()), label };
};
const f3 = await pdfDone('review.pdf');
if (!f3.includes(apiToken) || !f3.includes(adminPw) || !f3.includes('EMAIL') || !f3.includes('PHONE')) await fail('review.pdf findings:\n' + f3);
const r3 = await report();
if (!/Title “Quarterly Ops Review”/.test(r3) || !/link/.test(r3) || !/OCR on page 1/.test(r3) || !/no masked value is readable/.test(r3)) await fail('review.pdf report:\n' + r3);
await page.getByText('Masked text', { exact: true }).click();
const pdfMasked = await page.locator('.maskedtext pre').innerText();
const tokenPh = /api_token = (\[[A-Z_]+_\d+\])/.exec(pdfMasked)?.[1];
if (!tokenPh || pdfMasked.includes(apiToken) || pdfMasked.includes(adminPw) || !pdfMasked.includes('=== Page 2 ===')) await fail('review.pdf masked text:\n' + pdfMasked);
const out3 = await pdfDownload('text PDF');
const f4 = await pdfDone('scan.pdf');
if (!f4.includes(dbPw) || !f4.includes('EMAIL')) await fail('scan.pdf findings:\n' + f4);
const out4 = await pdfDownload('scanned PDF');
if (out3.name !== 'review-redacted.pdf' || out4.name !== 'scan-redacted.pdf') await fail(`PDF download names ${out3.name}, ${out4.name}`);
// a PDF with a password: asked for, a wrong one refused, then read
await page.locator('input[type=file][multiple]').setInputFiles([{ name: 'locked.pdf', mimeType: 'application/pdf', buffer: locked }]);
await page.getByLabel('PDF password').fill('wrong');
await page.getByRole('button', { name: 'Open', exact: true }).click();
await page.getByText('That password is not correct.').waitFor({ timeout: 20000 });
await page.getByLabel('PDF password').fill('open-sesame');
await page.getByRole('button', { name: 'Open', exact: true }).click();
if (!(await pdfDone('locked.pdf')).includes(lockedPw)) await fail('locked.pdf: the password in it was not found');

// a Word file: text masked in its XML, its picture redacted as an image document of its own
await page.locator('input[type=file][multiple]').setInputFiles([{ name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx(['Release notes', ['api_tok', 'en = ' + docToken.slice(0, 6), docToken.slice(6)], 'Contact ops@acme.io for access.'], docShot, 'Jane Example', 'rotate ' + docToken) }]);
await page.getByRole('button', { name: 'notes.docx', exact: true }).click();
await page.waitForSelector('.out mark.ph', { timeout: 30000 });
const docMasked = await page.locator('.out').innerText();
if (docMasked.includes(docToken) || !/api_token = \[/.test(docMasked) || !docMasked.includes('=== Comments ===')) await fail('notes.docx masked text:\n' + docMasked);
if (!/Authors of comments and changes renamed: Jane Example → Author 1/.test(await page.locator('ul.report').innerText())) await fail('notes.docx report: ' + (await page.locator('ul.report').innerText()));
if (!(await done('notes.docx › image1.png')).includes(dbPw)) await fail('the picture in notes.docx: password not found');
await page.locator('.reviewed input').check();
await page.getByRole('button', { name: 'notes.docx', exact: true }).click();
await page.getByRole('button', { name: 'image1.png ✓' }).waitFor({ timeout: 10000 });
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download redacted copy' }).click()]);
if (dl.suggestedFilename() !== 'notes-redacted.docx') await fail('docx download name ' + dl.suggestedFilename());
const docOut = readFileSync(await dl.path());
const docParts = unzipSync(new Uint8Array(docOut));
const docXml = Object.entries(docParts).filter(([n]) => /\.(?:xml|rels)$/.test(n)).map(([, b]) => new TextDecoder().decode(b)).join('\n');
if (docXml.includes(docToken) || docXml.includes('Jane Example') || docXml.includes('ops@acme') || !docXml.includes('Author 1')) await fail('notes-redacted.docx still holds a masked value or the author');
// LibreOffice opens the copy (when it is installed)
try {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-docx-'));
  writeFileSync(join(dir, 'copy.docx'), docOut);
  execFileSync('soffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', dir, join(dir, 'copy.docx')], { stdio: 'ignore', timeout: 120000 });
  const txt = readFileSync(join(dir, 'copy.txt'), 'utf8');
  if (!/api_token = \[/.test(txt) || txt.includes(docToken)) await fail('LibreOffice reads the copy as:\n' + txt);
} catch (e) {
  if (!/ENOENT/.test(String(e))) await fail('LibreOffice could not open the copy: ' + e);
}

// the copies: OCR (in the self-test page) must not read the masked values any more
const check = await browser.newPage();
await check.goto(FILE + '#selftest');
await check.waitForFunction(() => !!globalThis.__airlockSelfTest, null, { timeout: 30000 });
const masked = /4539 ?5787|ops@acme|jane\.doe/;
for (const o of [out1, out2, { label: 'picture in the Word copy', bytes: Buffer.from(docParts['word/media/image1.png']) }]) {
  const text = await check.evaluate((b) => globalThis.__airlockSelfTest.readText(b), o.bytes.toString('base64'));
  if (text.includes(dbPw)) await fail(`${o.label} still shows a masked value:\n${text}`);
  if (text.includes(secret) || masked.test(text)) await fail(`${o.label} copy still shows a masked value:\n${text}`);
}
for (const [o, pages] of [[out3, 2], [out4, 1]]) {
  const info = await check.evaluate((b) => globalThis.__airlockSelfTest.pdfInfo(b, true), o.bytes.toString('base64'));
  if (info.pages.length !== pages) await fail(`${o.label} copy: ${info.pages.length} pages`);
  if (info.pages.some((x) => x.text || x.annots) || info.inv.info.length || info.inv.xmp || info.inv.attachments.length) await fail(`${o.label} copy carries text, annotations or metadata: ` + JSON.stringify({ ...info, pages: info.pages.map((x) => ({ ...x, png: undefined })) }));
  for (const pg of info.pages) {
    const text = await check.evaluate((b) => globalThis.__airlockSelfTest.readText(b), pg.png);
    if ([apiToken, adminPw, dbPw].some((v) => text.includes(v)) || masked.test(text)) await fail(`${o.label} copy still shows a masked value:\n${text}`);
  }
}
// the face model still loads from memory (used by a later phase)
const fm = await check.evaluate((b) => globalThis.__airlockSelfTest.faces(b), embedded);
if (fm.shapes.length !== 4) await fail('face model outputs: ' + JSON.stringify(fm));

// restore puts back what a box label stands for
await page.getByRole('tab', { name: /Restore/ }).click();
await page.getByLabel('AI reply').fill('Rotate [PASSWORD_1] and the code behind [QR_1].');
await page.waitForFunction(() => (document.querySelector('.out')?.textContent ?? '').startsWith('Rotate'), null, { timeout: 8000 });
const restored = await page.locator('.out').innerText();
if (!restored.includes('otpauth://') || /\[(?:PASSWORD|QR)_1\]/.test(restored)) await fail('restore of box labels: ' + restored);
await page.getByLabel('AI reply').fill(`Revoke ${tokenPh} now.`);
await page.waitForFunction((v) => (document.querySelector('.out')?.textContent ?? '').includes(v), apiToken, { timeout: 8000 }).catch(() => {});
if (!(await page.locator('.out').innerText()).includes(apiToken)) await fail('restore of a PDF placeholder: ' + (await page.locator('.out').innerText()));

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

console.log('smoke-media OK: PNG (text chunk, QR) and JPEG (EXIF GPS) redacted without metadata, nothing readable | pasted screenshot | embedded image | text PDF (text layer + screenshot), scanned PDF and a PDF with a password: image-only copies without text or metadata, nothing readable | Word file masked in place, its picture redacted, author renamed, opens in LibreOffice | restore of box labels and PDF placeholders | face model loads | no requests, no CSP violations');
await browser.close();
