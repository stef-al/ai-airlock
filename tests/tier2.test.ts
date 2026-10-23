import { describe, expect, it } from 'vitest';
import { defaultSettings, Mapping, maskText, mergeSettings, restoreText, type Settings } from '../src/engine';
import { ID_PACKS } from '../src/engine/detectors/ids';
import { ID_PACK_META } from '../src/engine/meta';
import { expandMacros } from './tokens';

const S = (p?: Partial<Settings>) => mergeSettings(defaultSettings('US'), p);
const run = (text: string, p?: Partial<Settings>, opts: Record<string, unknown> = {}, mapping = new Mapping()) => maskText(text, S(p), mapping, opts);
const masked = (text: string, p?: Partial<Settings>) => run(text, p).hits.map((h) => `${h.type}:${text.slice(h.start, h.end)}`);

describe('network', () => {
  it('masks public and private IPv4, keeps loopback, netmasks, doc ranges and versions', () => {
    const t = 'from 52.14.200.31 to 10.0.0.5, lo 127.0.0.1 any 0.0.0.0 mask 255.255.255.0 doc 192.0.2.9 agent v1.2.3.4 version 4.17.21.3';
    expect(masked(t)).toEqual(['IP:52.14.200.31', 'IP:10.0.0.5']);
    expect(masked(t, { options: { ipPrivate: false } })).toEqual(['IP:52.14.200.31']);
    expect(masked(t, { options: { ipLocalhost: true } })).toEqual(['IP:52.14.200.31', 'IP:10.0.0.5', 'IP:127.0.0.1', 'IP:0.0.0.0']);
  });
  it('uses documentation addresses as placeholders and restores them', () => {
    const m = new Mapping();
    const r = run('a 52.14.200.31 b 8.8.8.8 c 52.14.200.31', {}, {}, m);
    expect(r.output).toBe('a 192.0.2.1 b 192.0.2.2 c 192.0.2.1');
    expect(restoreText('use 192.0.2.2 then 192.0.2.1', m).output).toBe('use 8.8.8.8 then 52.14.200.31');
  });
  it('handles IPv6 and MAC addresses', () => {
    const t = 'v6 2a02:26f0:1700::b819:1d4 ll fe80::1c2b:3dff:fe4a:77a1 lo ::1 doc 2001:db8::5 mac 3C:22:FB:7A:19:E0 and 00-1a-2b-3c-4d-5e, time 12:30:45';
    expect(masked(t)).toEqual(['IPV6:2a02:26f0:1700::b819:1d4', 'IPV6:fe80::1c2b:3dff:fe4a:77a1', 'MAC:3C:22:FB:7A:19:E0', 'MAC:00-1a-2b-3c-4d-5e']);
    const r = run(t);
    expect(r.output).toContain('2001:db8::1');
    expect(r.output).toContain('00:00:5E:00:53:01');
    expect(r.output).toContain('00-00-5e-00-53-02');
    expect(restoreText(r.output, r.mapping).output).toBe(t);
  });
  it('masks hosts under internal suffixes and company domains (fake in URLs, token in prose)', () => {
    const t = 'ssh deploy@build01.internal then https://api.northwind-traders.com/v1 and docs.example.com, file settings.local.js';
    const r = run(t, { options: { companyDomains: ['northwind-traders.com'] } });
    expect(r.output).toBe('ssh deploy@[HOST_1] then https://srv2.example.net/v1 and docs.example.com, file settings.local.js');
    expect(restoreText(r.output, r.mapping).output).toBe(t);
    expect(run('see db01.corp for details').output).toBe('see [HOST_1] for details');
    expect(masked('x db01.staging.mycorp', { options: { hostSuffixes: ['mycorp'] } })).toEqual(['HOST:db01.staging.mycorp']);
  });
});

describe('names and organizations', () => {
  it('needs a cue for people', () => {
    expect(masked('Hi Tom, call Anna Smith tomorrow.')).toEqual(['PERSON:Tom']);
    expect(masked('Hello World, Hi everyone, Dear Customer, Will you join? May I add Mark Down?')).toEqual([]);
    expect(masked('Kind regards,\nMaria Lopez\n')).toEqual(['PERSON:Maria Lopez']);
    expect(masked('Dr. Alvarez von Lyon Logistique S.A. replied')).toEqual(['PERSON:Alvarez', 'ORG:Lyon Logistique S.A.']);
    expect(masked('Frau Keller und Mr Daniel Okafor')).toEqual(['PERSON:Keller', 'PERSON:Daniel Okafor']);
  });
  it('derives names from emails and propagates cue-verified names', () => {
    const t = 'Mail john.smith@acme.io\nLater, John Smith said that Smith, John is out. info@acme.io is not a person.';
    expect(masked(t)).toContain('PERSON:John Smith');
    expect(masked(t).filter((x) => x.startsWith('PERSON')).length).toBe(2);
    const t2 = 'From: Katrin Vogel <katrin@acme.io>\nBody: Katrin Vogel asked. Katrin will call.';
    expect(masked(t2).filter((x) => x.startsWith('PERSON:Katrin')).length).toBe(3);
  });
  it('lists-only pairs need aggressive', () => {
    const t = 'yesterday Anna Smith visited';
    expect(masked(t)).toEqual([]);
    expect(masked(t, { sensitivity: 'aggressive' })).toEqual(['PERSON:Anna Smith']);
  });
  it('recognizes legal forms and leaves ordinary words alone', () => {
    const t = 'Acme Industries GmbH, Brandt & Söhne GmbH, Kowalski Sp. z o.o. and Novák s.r.o. signed. The Limited warranty and Company policy stay.';
    expect(masked(t)).toEqual(['ORG:Acme Industries GmbH', 'ORG:Brandt & Söhne GmbH', 'ORG:Kowalski Sp. z o.o.', 'ORG:Novák s.r.o.']);
  });
  it('custom list terms with hyphens work', () => {
    const lists = [{ id: 'l', name: 'c', type: 'CLIENT', enabled: true, terms: ['Rhein-Main Logistik'] }];
    expect(masked('about Rhein-Main Logistik today', { customLists: lists })).toEqual(['CLIENT:Rhein-Main Logistik']);
  });
});

describe('paths and dates', () => {
  it('masks user names in home paths with a path-safe token', () => {
    const t = 'cat /home/jsmith/.bashrc C:\\Users\\mnowak\\Desktop /home/ubuntu/x C:\\Users\\Public\\y /home/<user>/z';
    expect(masked(t)).toEqual(['USERNAME:jsmith', 'USERNAME:mnowak']);
    expect(run(t).output).toContain('/home/USERNAME_1/.bashrc');
  });
  it('needs a birth cue and a real date', () => {
    expect(masked('Date of birth: 14.03.1985, DOB 1990-07-23 and born on March 3, 1979')).toEqual(['DOB:14.03.1985', 'DOB:1990-07-23', 'DOB:March 3, 1979']);
    expect(masked('Contract date: 14.03.1985, DOB 31.02.1990, born 2999-01-01')).toEqual([]);
    expect(masked('{"dob": "1991-07-23", "created": "2020-01-02"}')).toEqual(['DOB:1991-07-23']);
  });
});

describe('national IDs', () => {
  it('validates checksums and formats', () => {
    const ssn = expandMacros('{{ssn:3}}');
    const nino = expandMacros('{{nino:4}}');
    const pesel = expandMacros('{{pesel:5}}');
    const rc = expandMacros('{{rc:6}}');
    expect(masked(`ids ${ssn} ${nino} PESEL ${pesel} ${rc}`)).toEqual([`SSN:${ssn}`, `NINO:${nino}`, `PESEL:${pesel}`, `BIRTH_NUMBER:${rc}`]);
    // a bare 11-digit number needs a cue (label, JSON key, CSV header) unless the sensitivity is aggressive
    expect(masked(`ref ${pesel}`)).toEqual([]);
    expect(masked(`ref ${pesel}`, { sensitivity: 'aggressive' })).toEqual([`PESEL:${pesel}`]);
    expect(masked(`{"pesel": "${pesel}"}`)).toEqual([`PESEL:${pesel}`]);
    expect(masked(`ids 1111111111 1234567890 11111111111`, { sensitivity: 'aggressive' })).toEqual([]);
    const badPesel = pesel.slice(0, 10) + String((+pesel[10] + 1) % 10);
    expect(masked(`ids ${badPesel} 000-12-3456 666-12-3456 123-45-678 BG123456A`)).toEqual([]);
    const bareSsn = ssn.replace(/-/g, '');
    expect(masked(`order ${bareSsn}`)).toEqual([]);
    expect(masked(`SSN: ${bareSsn}`)).toEqual([`SSN:${bareSsn}`]);
  });
  it('packs can be switched off and are listed for the UI', () => {
    const pesel = expandMacros('{{pesel:5}}');
    expect(masked(`PESEL: ${pesel}`)).toEqual([`PESEL:${pesel}`]);
    expect(masked(`PESEL: ${pesel}`, { options: { idPacksOff: ['pl-pesel'] } })).toEqual([]);
    expect(ID_PACK_META.map((p) => p.id).sort()).toEqual(ID_PACKS.map((p) => p.id).sort());
  });
  it('keeps numbers numeric in JSON', () => {
    const pesel = expandMacros('{{pesel:5}}');
    const r = run(`{"pesel": ${pesel}, "a": 1}`);
    expect(r.output).toMatch(/"pesel": \d{11},/);
    expect(r.output).not.toContain(pesel);
    expect(r.guard.ok).toBe(true);
    expect(restoreText(r.output, r.mapping).output).toBe(`{"pesel": ${pesel}, "a": 1}`);
  });
});
