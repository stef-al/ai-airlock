import { describe, expect, it } from 'vitest';
import { analyze, Cancelled, defaultSettings, mask, Mapping, maskText, mergeSettings, restoreText, type Settings } from '../src/engine';
import { ibanValid, luhn } from '../src/engine/detectors/financial';
import { compileUserRegex } from '../src/engine/detectors/custom';
import { KeyAnalyzer, DEFAULT_KEYWORDS, DEFAULT_QUALIFIERS } from '../src/engine/cues';
import { expandMacros } from './tokens';

const S = (p?: Partial<Settings>) => mergeSettings(defaultSettings('US'), p);
const run = (text: string, p?: Partial<Settings>, opts: Record<string, unknown> = {}, mapping = new Mapping()) => maskText(text, S(p), mapping, opts);

describe('validators', () => {
  it('luhn and iban', () => {
    expect(luhn('4539578763621486')).toBe(true);
    expect(luhn('4539578763621487')).toBe(false);
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
    expect(ibanValid('DE89 3704 0044 0532 0130 00')).toBe(true);
  });
});

describe('key analysis', () => {
  const an = new KeyAnalyzer(DEFAULT_KEYWORDS, DEFAULT_QUALIFIERS);
  const secret = (k: string) => {
    const r = an.analyze(k);
    return !!r && !r.negated;
  };
  it('treats names as cues only for values', () => {
    for (const k of ['password', 'db_password', 'DB_PASSWORD', 'dbPassword', 'ServicePassword', 'PGPASSWORD', 'x-api-key', 'client_secret', 'AWS_SECRET_ACCESS_KEY', 'smtp.password', 'Passwort', 'mot_de_passe', 'contraseña', 'hasło']) expect(secret(k), k).toBe(true);
    for (const k of ['password_hash', 'PASSWORD_MIN_LENGTH', 'getPassword', 'PasswordService', 'token_url', 'secret_name', 'passwordField', 'tokenizer', 'username', 'monkey', 'compass']) expect(secret(k), k).toBe(false);
  });
});

describe('placeholders', () => {
  it('uses context-safe forms', () => {
    const y = run('db:\n  password: hunter22x\n');
    expect(y.output).toContain('password: PASSWORD_1');
    const j = run('{"pin": 482913, "password": "hunter22x"}');
    expect(j.output).toMatch(/"pin": \d{6},/);
    expect(j.output).toContain('"[PASSWORD_1]"');
    const e = run('{"email": "bob@acme.io"}');
    expect(e.output).toContain('user1@example.com');
    const p = run('mail me: bob@acme.io');
    expect(p.output).toContain('[EMAIL_1]');
    const u = run('conn = "postgres://app:Tr0ub4dor9@db:5432/x"');
    expect(u.output).toContain('app:PASSWORD_1@db');
  });
  it('same value → same placeholder, different values never collide, input tokens are skipped', () => {
    const m = new Mapping();
    const a = run('password=hunter22x\ntoken=abcdEFGH1234ijkl\nPASSWORD_1 is already in the text\n', {}, {}, m);
    expect(a.output).toContain('password=[PASSWORD_2]');
    const b = run('password=hunter22x', {}, {}, m);
    expect(b.output).toBe('password=[PASSWORD_2]');
    const c = run('password=another99pw', {}, {}, m);
    expect(c.output).toBe('password=[PASSWORD_3]');
  });
  it('fakes and redaction are configurable per category', () => {
    const f = run('password=hunter22x', { categories: { secret: { enabled: true, style: 'fake' } } as never });
    expect(f.output).not.toContain('hunter22x');
    expect(f.output).toMatch(/password=[a-z]{6}\d{2}[a-z]$/);
    expect(restoreText(f.output, f.mapping).output).toBe('password=hunter22x');
    const r = run('password=hunter22x', { categories: { secret: { enabled: true, style: 'redact' } } as never });
    expect(r.output).toBe('password=█████');
  });
  it('masks identifiers only when asked, keeping them valid', () => {
    const code = 'class AcmeBankService {\n  getAcmeBank() { return acme_bank_id; }\n}\n';
    const lists = [{ id: 'l', name: 'Clients', type: 'CLIENT', enabled: true, terms: ['Acme Bank'] }];
    const off = run(code, { customLists: lists }, { format: 'code', lang: 'js' });
    expect(off.output).toBe(code);
    const on = run(code, { customLists: lists, detectors: { 'custom.lists': { scopes: ['prose', 'comment', 'string', 'config', 'identifier'] } } }, { format: 'code', lang: 'js' });
    expect(on.output).toContain('class Client1Service');
    expect(on.output).toContain('getClient1()');
    expect(on.output).toMatch(/return client\d_id;/);
    expect(on.guard.ok).toBe(true);
    expect(restoreText(on.output, on.mapping).output).toBe(code);
  });
});

describe('structure guard', () => {
  it('skips and flags replacements that would break the structure', () => {
    const text = '{"n": 5, "name": "x"}';
    const r = run(text, { regexRules: [{ id: 'r', name: 'digit', type: 'NUM', pattern: '\\b5\\b', flags: '', enabled: true }] });
    expect(r.output).toBe(text);
    expect(r.skipped.length).toBe(1);
    expect(r.guard.ok).toBe(true);
    expect(r.guard.issues.join()).toContain('skipped');
  });
  it('never touches keys, tags, headers or identifiers', () => {
    const cases: [string, string][] = [
      ['{"password": "hunter22x", "user": "bob"}', 'json'],
      ['<cfg><password>hunter22x</password></cfg>', 'xml'],
      ['user,password\nbob,hunter22x\n', 'csv'],
      ['password: hunter22x\nname: bob\n', 'yaml'],
    ];
    for (const [t] of cases) {
      const r = run(t);
      expect(r.guard.ok).toBe(true);
      expect(r.output).toMatch(/password/);
    }
  });
});

describe('restore', () => {
  it('tolerates what chatbots do to placeholders', () => {
    const m = new Mapping();
    const r = run('password=hunter22x and contact bob@acme.io, token=abcdEFGH1234ijklmn', {}, {}, m);
    const variants = ['[PASSWORD_1]', 'PASSWORD_1', '`PASSWORD_1`', '[password_1]', 'Password-1', '**[PASSWORD_1]**', '[ PASSWORD_1 ]'];
    for (const v of variants) {
      const out = restoreText(`use ${v} here`, m).output;
      expect(out, v).toContain('hunter22x');
      expect(out, v).not.toMatch(/password/i);
    }
    const fake = r.mapping.entries().find((e) => e.type === 'EMAIL')!;
    expect(fake).toBeTruthy();
    const rep = restoreText('Mail [EMAIL_1] and [PASSWORD_9] and TOKEN_1 and [FOO_3]', m, ['PASSWORD_1', 'EMAIL_1']);
    expect(rep.output).toContain('bob@acme.io');
    expect(rep.unknown).toEqual(['[PASSWORD_9]']);
    expect(rep.missing).toEqual(['PASSWORD_1']);
    expect(rep.restored.map((x) => x.id).sort()).toEqual(['EMAIL_1', 'TOKEN_1']);
  });
  it('restores fake emails in a different case', () => {
    const m = new Mapping();
    run('{"mail": "Bob@Acme.io"}', {}, {}, m);
    expect(restoreText('send to USER1@Example.COM please', m).output).toBe('send to Bob@Acme.io please');
  });
});

describe('settings', () => {
  it('allowlist keeps terms and regexes', () => {
    const t = 'mail a@corp.com and b@example.com';
    expect(run(t).output).toBe('mail [EMAIL_1] and b@example.com');
    expect(run(t, { allowlist: { terms: ['corp.com', 'example.com'], regexes: [] } }).output).toBe(t);
    expect(run(t, { allowlist: { terms: [], regexes: ['^a@'] } }).output).toBe('mail a@corp.com and [EMAIL_1]');
  });
  it('sensitivity gates rules', () => {
    const aws = expandMacros('{{aws:1}}');
    const t = `password=hunter22x key=${aws}`;
    const strict = run(t, { sensitivity: 'strict' });
    expect(strict.output).toContain('password=hunter22x');
    expect(strict.output).not.toContain(aws);
    expect(run(t).output).not.toContain('hunter22x');
  });
  it('category and detector switches', () => {
    expect(run('a@b.org', { categories: { personal: { enabled: false } } as never }).output).toBe('a@b.org');
    expect(run('a@b.org', { detectors: { 'contact.email': { enabled: false } } }).output).toBe('a@b.org');
  });
  it('keep-once removes a single span', () => {
    const t = 'a@b.org and c@d.org';
    const a = analyze(t, S(), { keepOnce: new Set(['0:a@b.org']) });
    expect(a.hits.length).toBe(1);
  });
  it('user regex rules are validated', () => {
    expect(typeof compileUserRegex('(a+)+$', '')).toBe('string');
    expect(typeof compileUserRegex('(', '')).toBe('string');
    expect(compileUserRegex('ORD-\\d+', 'i')).toBeInstanceOf(RegExp);
    const r = run('see ORD-1234 now', { regexRules: [{ id: 'r', name: 'orders', type: 'order', pattern: 'ORD-\\d+', flags: '', enabled: true }] });
    expect(r.output).toBe('see [ORDER_1] now');
  });
});

describe('robustness', () => {
  it('can be cancelled', () => {
    let n = 0;
    expect(() => analyze('password=abc12345 '.repeat(1000), S(), { check: () => { if (++n > 3) throw new Cancelled(); } })).toThrow(Cancelled);
  });
  it('has no catastrophic backtracking on hostile input', () => {
    const big = 300000;
    const inputs = [
      'a'.repeat(big), '0'.repeat(big), '@'.repeat(big / 4), 'A'.repeat(big / 2) + '@', 'password='.repeat(big / 10),
      '"\\'.repeat(big / 4), '1 '.repeat(big / 2), '-'.repeat(big), '=+/'.repeat(big / 3), 'a.'.repeat(big / 2) + 'b@', '://'.repeat(big / 6),
      '-----BEGIN RSA PRIVATE KEY-----'.repeat(2000), 'DE89 '.repeat(big / 10), '4111 '.repeat(big / 10), 'password is '.repeat(big / 20),
      'eyJ'.repeat(big / 6), '$2a$10$'.repeat(big / 14), '['.repeat(big / 2), '\n'.repeat(big), 'x='.repeat(big / 2),
    ];
    for (const s of inputs) {
      const t0 = Date.now();
      analyze(s, S({ sensitivity: 'aggressive' }));
      expect(Date.now() - t0, s.slice(0, 20)).toBeLessThan(4000);
    }
  });
  it('handles a 2 MB log in a few seconds', () => {
    const line = '2024-08-15 10:30:46,001 INFO [http-1] login user=sam@acme.io password=Hunter22x! from 10.0.0.5 trace 3f2a9c1e-1111-4222-8333-444455556666\n';
    const text = line.repeat(Math.ceil((2 * 1024 * 1024) / line.length));
    const t0 = Date.now();
    const r = run(text);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(r.hits.length).toBeGreaterThan(10000);
    expect(r.guard.ok).toBe(true);
  });
  it('never lets mask crash on empty or odd input', () => {
    for (const t of ['', ' ', '\n\n', '{', '<', '```', '|', '\u0000', '"', '[[[[']) {
      const r = run(t);
      expect(r.output).toBe(t);
    }
  });
});

describe('modules', () => {
  it('mask() works with a prepared analysis', () => {
    const a = analyze('password=hunter22x', S());
    const m = new Mapping();
    expect(mask(a.doc, a.hits, m, S()).output).toBe('password=[PASSWORD_1]');
  });
});
