// End-to-end smoke test in a real browser, opening the built file from disk (file://).
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] }).catch(() => chromium.launch({ args: ['--no-sandbox'] }));
const page = await browser.newPage();
const problems = [];
const requests = [];
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('request', (r) => requests.push(r.url()));
await page.goto('file://' + resolve('dist/airlock.html'));
const secret = ['Summer', '2024!'].join('');
await page.getByLabel('Text to mask').fill(`db:\n  host: x\n  password: ${secret}\ncontact: bob@acme.io\n`);
await page.waitForSelector('.out mark.ph', { timeout: 15000 });
const masked = await page.locator('.out').innerText();
if (masked.includes(secret) || masked.includes('bob@acme.io')) throw new Error('secret leaked into masked output:\n' + masked);
if (!/PASSWORD_1/.test(masked)) throw new Error('no placeholder in output:\n' + masked);
const guard = await page.locator('.chip.ok').first().innerText();
await page.getByRole('tab', { name: /Restore/ }).click();
await page.getByLabel('AI reply').fill('Use [PASSWORD_1] for the db and write to `PASSWORD_1` again.');
await page.waitForFunction((s) => document.querySelector('.out')?.textContent?.includes(s), secret, { timeout: 8000 });
const restored = await page.locator('.out').innerText();
if (restored.split(secret).length !== 3) throw new Error('restore failed:\n' + restored);
await page.getByRole('tab', { name: 'Settings' }).click();
await page.getByRole('heading', { name: 'Network, names and IDs' }).waitFor({ timeout: 5000 });
await page.getByRole('tab', { name: /Mask/ }).click();
await page.getByLabel('Text to mask').fill('Hi Tom,\nssh jdoe@build01.internal from 52.14.200.31, DOB: 14.03.1985\nRegards,\nMaria Lopez\n');
await page.waitForFunction(() => !!document.querySelector('.out mark.ph') && /IP_?1|192\.0\.2\.1/.test(document.querySelector('.out')?.textContent ?? ''), null, { timeout: 15000 });
const t2 = await page.locator('.out').innerText();
if (/Tom|Maria|52\.14|1985|build01/.test(t2)) throw new Error('tier 2 data leaked:\n' + t2);
// two files at once: each gets its own placeholder and both restore (the mapping is threaded through the job queue)
const sa = ['Alpha', 'Pw', '-7731'].join('');
const sb = ['Beta', 'Pw', '-9142'].join('');
await page.locator('input[type=file][multiple]').setInputFiles([
  { name: 'a.env', mimeType: 'text/plain', buffer: Buffer.from(`DB_PASSWORD=${sa}\n`) },
  // UTF-16 with BOM, as Windows PowerShell writes files
  { name: 'b.yaml', mimeType: 'text/plain', buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`db:\n  password: ${sb}\n`, 'utf16le')]) },
]);
const placeholderOf = async (name) => {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('.out:not(.stale) mark.ph'), null, { timeout: 15000 });
  return page.locator('.out mark.ph').first().innerText();
};
const pa = await placeholderOf('a.env');
const pb = await placeholderOf('b.yaml');
if (pa === pb) throw new Error(`two different values got the same placeholder ${pa}`);
// keyboard: a highlight can be focused and opened without a mouse
await page.locator('mark.hl').first().focus();
await page.keyboard.press('Enter');
await page.locator('.detail').waitFor({ timeout: 5000 });
await page.getByRole('tab', { name: /Restore/ }).click();
await page.getByLabel('AI reply').fill(`a=${pa} b=${pb}`);
await page.waitForFunction((s) => document.querySelector('.out')?.textContent?.includes(s), sb, { timeout: 8000 });
const both = await page.locator('.out').innerText();
if (both.trim() !== `a=${sa} b=${sb}`) throw new Error('multi-document restore failed: ' + both);
const external = requests.filter((u) => !u.startsWith('file:') && !u.startsWith('blob:') && !u.startsWith('data:'));
if (external.length) throw new Error('network requests: ' + external.join(', '));
// CSP really blocks outgoing requests
const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => 'LEAK', () => 'blocked'));
if (blocked !== 'blocked') throw new Error('fetch was not blocked by CSP');
if (problems.some((p) => !/Content Security Policy|Refused to connect/.test(p))) throw new Error('console problems:\n' + problems.join('\n'));
console.log('smoke OK:', guard, '| restore OK | two files (one UTF-16) restore | keyboard review | fetch blocked by CSP | no external requests');
await browser.close();
