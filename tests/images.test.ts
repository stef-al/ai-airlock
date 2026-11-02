import { describe, expect, it } from 'vitest';
import { analyze, defaultSettings, Mapping, maskText, mergeSettings, restoreText, type Settings } from '../src/engine';
import { mrzCheck } from '../src/engine/detectors/ids/mrz';

const S = (p?: Partial<Settings>) => mergeSettings(defaultSettings('US'), p);
const found = (text: string, opts: { ocr?: boolean } = {}, p?: Partial<Settings>) =>
  analyze(text, S(p), { format: 'prose', ...opts }).hits.map((h) => `${h.type}:${text.slice(h.start, h.end)}`);

/** A TD3 (passport) machine-readable zone for made-up data, with computed check digits. */
function td3(surname: string, given: string, doc: string, dob: string, exp: string): string {
  const l1 = ('P<UTO' + surname + '<<' + given.replace(/ /g, '<')).padEnd(44, '<');
  const docF = doc.padEnd(9, '<');
  const personal = '<'.repeat(14);
  const l2a = docF + mrzCheck(docF) + 'UTO' + dob + mrzCheck(dob) + 'F' + exp + mrzCheck(exp) + personal + mrzCheck(personal);
  const composite = mrzCheck(l2a.slice(0, 10) + l2a.slice(13, 20) + l2a.slice(21, 43));
  return l1 + '\n' + l2a + composite;
}

describe('images: engine side', () => {
  it('finds passport machine-readable zones by their check digits', () => {
    const z = td3('ERIKSEN', 'ANNA MARIA', 'X4R7T2K9', '880214', '310911');
    expect(z.split('\n').map((l) => l.length)).toEqual([44, 44]);
    expect(found(`Scan of the passport:\n${z}\nEnd.`)).toEqual([`MRZ:${z}`]);
    // one wrong check digit: not an MRZ in typed text, still one in OCR text
    const broken = z.slice(0, 54) + ((+z[54] + 1) % 10) + z.slice(55);
    expect(found(broken)).toEqual([]);
    expect(found(broken, { ocr: true })).toEqual([`MRZ:${broken}`]);
    // ordinary upper-case text is not an MRZ
    expect(found('PLEASE READ THE ATTACHED NOTICE CAREFULLY NOW\nAND SIGN BOTH COPIES BEFORE THE DEADLINE ENDS')).toEqual([]);
  });

  it('counts checksummed shapes next to a cue in OCR text, where one digit can be misread', () => {
    const card = 'card 4539 5787 6362 1487'; // last digit misread: Luhn fails
    expect(found(card)).toEqual([]);
    expect(found(card, { ocr: true })).toEqual(['CARD:4539 5787 6362 1487']);
    const iban = 'IBAN DE89 3704 0044 0532 0130 01'; // mod-97 fails
    expect(found(iban)).toEqual([]);
    expect(found(iban, { ocr: true })).toEqual(['IBAN:DE89 3704 0044 0532 0130 01']);
    // without a cue an unverified number stays unmasked: OCR text is full of digit runs
    expect(found('ref 4539 5787 6362 1487', { ocr: true })).toEqual([]);
  });

  it('needs a cue for random-looking strings in OCR text', () => {
    const noise = 'iL1|lI1l q7Zx9Lm2Vb8Tr4Wk6Ns1Pj3';
    const aggressive = { sensitivity: 'aggressive' as const };
    expect(found(noise, {}, aggressive).length).toBeGreaterThan(0);
    expect(found(noise, { ocr: true }, aggressive)).toEqual([]);
    expect(found('api key: q7Zx9Lm2Vb8Tr4Wk6Ns1Pj3', { ocr: true }, aggressive).length).toBe(1);
  });

  it('masks every other occurrence of a value it found once, with the same placeholder', () => {
    const pw = ['Kv7', 'mQ2', 'wZ9', 'pL4'].join('');
    const t = `password=${pw}\nlater: the password ${pw} is shared (not ${pw}x)`;
    const r = maskText(t, S(), new Mapping(), { format: 'prose' });
    expect(r.output).toBe('password=[PASSWORD_1]\nlater: the password [PASSWORD_1] is shared (not ' + pw + 'x)');
    expect(r.hits[1].reason).toMatch(/same value as the password found on line 1/);
  });

  it('reads name/value pairs and secret elements written out in text', () => {
    expect(found('{ "name": "DB_PASSWORD", "value": "Ecs!Task-Pw8" },')).toEqual(['PASSWORD:Ecs!Task-Pw8']);
    expect(found('<add key="ServicePassword" value="Svc!Pw#2024" />')).toEqual(['PASSWORD:Svc!Pw#2024']);
    expect(found('  - name: API_KEY\n    value: czfkXH6QZNFCUU8IEpLM8tyZO3R3d3M1Plu7jGQT')).toEqual(['API_KEY:czfkXH6QZNFCUU8IEpLM8tyZO3R3d3M1Plu7jGQT']);
    expect(found('<password>El3ment-Pw</password>')).toEqual(['PASSWORD:El3ment-Pw']);
    expect(found('<add key="MaxPasswordLength" value="64" /> <title>Password reset</title>')).toEqual([]);
  });

  it('reads OCR tables that lost their separator row', () => {
    const t = '| Service | Owner | Password |\n| Jenkins | ops | J3nkins#Prod |\n| Grafana | ops | Gr4f-2024! |';
    expect(found(t)).toEqual([]);
    expect(analyze(t, S(), { ocr: true }).hits.map((h) => t.slice(h.start, h.end))).toEqual(expect.arrayContaining(['J3nkins#Prod', 'Gr4f-2024!']));
  });

  it('masks images embedded in text and restores them', () => {
    const payload = 'iVBORw0KGgo' + 'A'.repeat(300) + 'ElFTkSuQmCC';
    const t = `See ![screenshot](data:image/png;base64,${payload}) and the logo data:image/png;base64,iVBORw0KGgo=`;
    const m = new Mapping();
    const r = maskText(t, S(), m, { fileName: 'notes.md' });
    expect(r.output).toContain('](data:image/png;base64,IMAGE_1)');
    expect(r.output).toContain('base64,iVBORw0KGgo='); // tiny images stay
    expect(r.hits.find((h) => h.type === 'IMAGE')?.reason).toMatch(/embedded png image/);
    expect(restoreText(r.output, m).output).toBe(t);
  });
});
