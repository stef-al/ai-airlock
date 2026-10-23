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
const external = requests.filter((u) => !u.startsWith('file:') && !u.startsWith('blob:') && !u.startsWith('data:'));
if (external.length) throw new Error('network requests: ' + external.join(', '));
// CSP really blocks outgoing requests
const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => 'LEAK', () => 'blocked'));
if (blocked !== 'blocked') throw new Error('fetch was not blocked by CSP');
if (problems.some((p) => !/Content Security Policy|Refused to connect/.test(p))) throw new Error('console problems:\n' + problems.join('\n'));
console.log('smoke OK:', guard, '| restore OK | fetch blocked by CSP | no external requests');
await browser.close();
