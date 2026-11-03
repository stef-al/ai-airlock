import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { defaultSettings, Mapping, maskText, mergeSettings } from '../src/engine';
import { buildCopy, openOffice } from '../src/media/office/office';
import { tags } from '../src/media/office/xml';
import { field, makeDocx, makePptx, makeXlsx, para, table, tracked } from './office-make';

const S = mergeSettings(defaultSettings('US'), {});
const pw = ['Kv7', 'mQ2', 'wZ9', 'pL4'].join('');
const jenkins = ['J3n', 'kins', '#Pr', 'od'].join('');
const oldPw = ['Old', '!Pw', '-99'].join('');
const token = ['q7Zx', '9Lm2', 'Vb8T', 'r4Wk', 'Ns1P'].join('');
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));

const sample = () =>
  makeDocx({
    body:
      para('Quarterly access review') +
      para(['The admin pass', 'word: ' + pw.slice(0, 5), pw.slice(5)]) +
      para('Contact jane.doe@acme-industries.com for access.') +
      table([['Service', 'Owner', 'Password'], ['Jenkins', 'ops', jenkins]]) +
      tracked('approved', 'old password ' + oldPw, 'Jane Example') +
      field('https://wiki.corp.local/sso?token=' + token),
    image: png,
    imageAlt: 'Screenshot of the console, api key ' + token,
    header: 'Prepared for Initech',
    comment: { author: 'Jane Example', text: 'rotate the password ' + pw + ' after the audit' },
    link: 'https://wiki.corp.local/runbook?access_token=' + token,
    core: { creator: 'Jane Example', title: 'Access review Initech' },
    company: 'Acme Industries GmbH',
    custom: ['Client', 'Initech'],
    thumbnail: true,
  });

/** every XML part of a package, as text */
const allXml = (bytes: Uint8Array) =>
  Object.entries(unzipSync(bytes))
    .filter(([n]) => /\.(?:xml|rels)$/.test(n))
    .map(([n, b]) => `--- ${n}\n` + new TextDecoder().decode(b))
    .join('\n');

function wellFormed(x: string): boolean {
  const stack: string[] = [];
  for (const t of tags(x)) {
    if (t.self) continue;
    if (!t.close) stack.push(t.name);
    else if (stack.pop() !== t.name) return false;
  }
  return stack.length === 0;
}

function redact(bytes: Uint8Array) {
  const f = openOffice(bytes);
  const m = maskText(f.text.text, S, new Mapping(), { fileName: 'document.md' });
  const reps = m.replacements.map((r) => ({ start: r.start, end: r.end, text: m.output.slice(r.outStart, r.outEnd) }));
  const images = new Map(f.media.map((x) => [x.path, { bytes: png, mime: 'image/png' }]));
  return { f, m, out: buildCopy(f, reps, images) };
}

describe('office: DOCX', () => {
  it('reads every place that holds text, as lines and Markdown tables', () => {
    const f = openOffice(sample());
    expect(f.kind).toBe('docx');
    const t = f.text.text;
    expect(t).toContain('The admin password: ' + pw);
    expect(t).toContain('| Service | Owner | Password |\n| --- | --- | --- |\n| Jenkins | ops | ' + jenkins + ' |');
    expect(t).toContain('Status: approved');
    expect(t).not.toContain(oldPw); // a tracked deletion is gone
    for (const h of ['=== Header ===\nPrepared for Initech', '=== Comments ===\nrotate the password', '=== Field codes ===\n HYPERLINK "https://wiki.corp.local/sso?token=' + token, '=== Alt text ===\nScreenshot of the console', '=== Links ===\nhttps://wiki.corp.local/runbook']) expect(t).toContain(h);
    expect(f.media.map((m) => m.path)).toEqual(['word/media/image1.png']);
  });

  it('reports and removes metadata, authors, tracked changes and the thumbnail', () => {
    const { report } = openOffice(sample());
    expect(report.properties).toEqual(expect.arrayContaining([['title', 'Access review Initech'], ['creator', 'Jane Example'], ['Company', 'Acme Industries GmbH'], ['Client', 'Initech']]));
    expect(report.thumbnail).toBe(true);
    expect(report.authors).toEqual(['Jane Example']);
    expect(report.changes).toEqual({ insertions: 1, deletions: 1, formatting: 0 });
  });

  it('writes the masked text into the XML and leaves no masked value or metadata in the file', () => {
    const { m, out } = redact(sample());
    expect(m.output).toContain('The admin password: [PASSWORD_1]');
    const xml = allXml(out);
    for (const v of [pw, jenkins, oldPw, token, 'jane.doe@acme', 'Jane Example', 'Acme Industries GmbH', 'Access review']) expect(xml, v).not.toContain(v);
    expect(xml).toContain('[PASSWORD_1]');
    // the value split over three runs: the placeholder in the first, the rest removed
    expect(xml).toMatch(/word: \[PASSWORD_1\]<\/w:t>/);
    expect(xml).toContain('w:author="Author 1"');
    expect(xml).not.toContain('presenceInfo');
    const files = unzipSync(out);
    expect(Object.keys(files)).not.toContain('docProps/custom.xml');
    expect(Object.keys(files)).not.toContain('docProps/thumbnail.jpeg');
    expect(new TextDecoder().decode(files['[Content_Types].xml'])).not.toContain('custom.xml');
    expect(new TextDecoder().decode(files['_rels/.rels'])).not.toMatch(/thumbnail|custom/);
    for (const [n, b] of Object.entries(files)) if (/\.(?:xml|rels)$/.test(n)) expect(wellFormed(new TextDecoder().decode(b)), n).toBe(true);
  });

  it('requires a redacted copy of every picture', () => {
    const f = openOffice(sample());
    expect(() => buildCopy(f, [], new Map())).toThrow(/no redacted copy/);
  });

  it('renames a picture whose redacted copy has another format', () => {
    const f = openOffice(sample());
    const out = unzipSync(buildCopy(f, [], new Map([['word/media/image1.png', { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg' }]])));
    expect(Object.keys(out)).toContain('word/media/image1.jpeg');
    expect(new TextDecoder().decode(out['word/_rels/document.xml.rels'])).toContain('Target="media/image1.jpeg"');
  });
});

describe('office: engine fixes found with documents', () => {
  it('finds a password on a line followed by a table', async () => {
    const { analyze } = await import('../src/engine');
    const t = 'The admin password: ' + pw + '\n\n| Service | Owner |\n| --- | --- |\n| Jenkins | ops |\n';
    expect(analyze(t, S, { fileName: 'd.md' }).hits.map((h) => t.slice(h.start, h.end))).toContain(pw);
  });
});

describe('office: PPTX', () => {
  const deck = () =>
    makePptx([
      { lines: [['Rollout plan'], ['Admin pass', 'word: ' + pw]], notes: 'Call Jane at jane.doe@acme-industries.com before the demo', comment: { author: 'Jane Example', text: 'the token is ' + token } },
      { lines: [['Thanks']] },
    ]);

  it('reads slides, notes, comments and footers, not the prompts of layouts', () => {
    const t = openOffice(deck()).text.text;
    expect(t).toContain('=== Slide 1 ===\nRollout plan\nAdmin password: ' + pw);
    expect(t).toContain('=== Slide 1 notes ===\nCall Jane at jane.doe@acme-industries.com');
    expect(t).toContain('=== Slide 1 comments ===\nthe token is ' + token);
    expect(t).toContain('=== Slide 2 ===\nThanks');
    expect(t).toContain('=== Masters and layouts ===\nFooter text');
    expect(t).not.toContain('Click to edit');
  });

  it('masks them in place and renames the comment author', () => {
    const { out, f } = redact(deck());
    expect(f.report.authors).toEqual(['Jane Example']);
    const xml = allXml(out);
    for (const v of [pw, token, 'jane.doe@acme', 'Jane Example']) expect(xml, v).not.toContain(v);
    expect(xml).toContain('name="Author 1"');
    for (const [n, b] of Object.entries(unzipSync(out))) if (/\.(?:xml|rels)$/.test(n)) expect(wellFormed(new TextDecoder().decode(b)), n).toBe(true);
  });
});

describe('office: XLSX', () => {
  const card = 4539578763621486;
  const book = () =>
    makeXlsx(
      [
        {
          name: 'Accounts',
          rows: [
            ['Service', 'Owner', 'Password', 'Card', 'Date of birth', 'Note'],
            ['Jenkins', 'ops', jenkins, card, { date: 28563 }, { formula: 'CONCAT("pw=",C2)', value: 'pw=' + jenkins }],
            ['Grafana', 'ops', pw, 1234, { date: 45000 }, 'ok'],
          ],
        },
      ],
      { author: 'Jane Example', text: 'rotated ' + pw },
    );

  it('shows sheets as Markdown tables: shared strings, numbers, dates and formula results', () => {
    const t = openOffice(book()).text.text;
    expect(t).toContain('=== Sheet Accounts ===\n| Service | Owner | Password | Card | Date of birth | Note |\n| --- | --- | --- | --- | --- | --- |');
    expect(t).toContain('| Jenkins | ops | ' + jenkins + ' | ' + card + ' | 1978-03-14 | pw=' + jenkins + ' |');
    expect(t).toContain('=== Headers and footers ===\n&CConfidential');
    expect(t).toContain('=== Comments ===\nrotated ' + pw);
  });

  it('masks shared strings once, turns masked numbers and dates into text cells and drops masked formulas', () => {
    const { out, m } = redact(book());
    expect(m.output).toMatch(/\| Jenkins \| \[PERSON_1\] \| \[PASSWORD_1\] \| \[CARD_1\] \| \[DOB_1\] \| pw=\[PASSWORD_1\] \|/);
    const xml = allXml(out);
    for (const v of [pw, jenkins, String(card), 'Jane Example']) expect(xml, v).not.toContain(v);
    expect(xml).toMatch(/<c r="D2" t="inlineStr"><is><t xml:space="preserve">\[CARD_1\]<\/t><\/is><\/c>/);
    expect(xml).not.toContain('CONCAT');
    expect(xml).toContain('<author>Author 1</author>');
    for (const [n, b] of Object.entries(unzipSync(out))) if (/\.(?:xml|rels)$/.test(n)) expect(wellFormed(new TextDecoder().decode(b)), n).toBe(true);
  });
});
