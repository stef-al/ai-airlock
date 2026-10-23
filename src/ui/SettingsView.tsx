import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
  BUILTIN_PROFILES, DEFAULT_HOST_SUFFIXES, DEFAULT_KEYWORDS, DEFAULT_QUALIFIERS, DETECTOR_META, ID_PACK_META, SCOPES, CATEGORIES, opt, defaultSettings, exportProfile, mergeSettings, parseProfile, regexRisk, typeName,
  type Category, type DetectorOverride, type PlaceholderStyle, type Profile, type RegexRule, type Scope, type Sensitivity, type Settings,
} from '../engine/light';
import type { RegexTestRes } from '../worker/protocol';
import { CancelledError, engine } from './engineClient';
import { downloadText, parseTerms } from './util';

interface Props {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  profiles: Profile[];
  setProfiles: Dispatch<SetStateAction<Profile[]>>;
  activeProfile: string;
  applyProfile(name: string): void;
}

const SENS: Sensitivity[] = ['strict', 'balanced', 'aggressive'];
const STYLES: PlaceholderStyle[] = ['token', 'fake', 'redact'];
const STYLE_HELP: Record<PlaceholderStyle, string> = { token: 'token [TYPE_N]', fake: 'format-preserving fake', redact: 'irreversible █████' };

/** Textarea that commits on blur so typing newlines is not eaten by normalisation. */
function Lines({ value, onCommit, rows = 5, label, placeholder }: { value: string[]; onCommit(v: string[]): void; rows?: number; label: string; placeholder?: string }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value]);
  return (
    <textarea aria-label={label} className="lines" rows={rows} value={text} placeholder={placeholder} spellCheck={false} onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(text.split('\n').map((l) => l.trim()).filter(Boolean))} />
  );
}

/** Two-letter region; only a complete code is applied. */
function RegionInput({ value, onCommit }: { value: string; onCommit(v: string): void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="short"
      aria-label="phone region"
      value={text}
      maxLength={2}
      onChange={(e) => {
        const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
        setText(v);
        if (/^[A-Z]{2}$/.test(v)) onCommit(v);
      }}
      onBlur={() => setText(value)}
    />
  );
}

export function SettingsView({ settings: s, setSettings, profiles, setProfiles, activeProfile, applyProfile }: Props) {
  const [saveName, setSaveName] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const up = (f: (x: Settings) => Settings) => setSettings((x) => f(x));
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 3500);
  };

  const setDet = (id: string, patch: Partial<DetectorOverride>) =>
    up((x) => {
      const cur = { ...(x.detectors[id] ?? {}), ...patch };
      for (const k of Object.keys(cur) as (keyof DetectorOverride)[]) if (cur[k] === undefined) delete cur[k];
      return { ...x, detectors: { ...x.detectors, [id]: cur } };
    });
  const setCat = (c: Category, patch: Partial<Settings['categories'][Category]>) =>
    up((x) => {
      const cur = { ...x.categories[c], ...patch };
      for (const k of Object.keys(cur) as (keyof typeof cur)[]) if (cur[k] === undefined) delete cur[k];
      return { ...x, categories: { ...x.categories, [c]: cur } };
    });

  const allProfiles = [...BUILTIN_PROFILES, ...profiles];
  const isCustom = profiles.some((p) => p.name === activeProfile);

  return (
    <div className="settings">
      <section className="panel">
        <h2>Profile</h2>
        <div className="row">
          <select aria-label="profile" value={activeProfile} onChange={(e) => applyProfile(e.target.value)}>
            <option value="">Current settings (unsaved)</option>
            {allProfiles.map((p) => <option key={p.name} value={p.name}>{p.builtin ? '● ' : ''}{p.name}</option>)}
          </select>
          {isCustom && <button onClick={() => { setProfiles((ps) => ps.map((p) => (p.name === activeProfile ? { ...p, settings: s } : p))); flash(`Profile "${activeProfile}" updated`); }}>Update profile</button>}
          {isCustom && <button onClick={() => { setProfiles((ps) => ps.filter((p) => p.name !== activeProfile)); applyProfile(''); }}>Delete</button>}
          <input aria-label="new profile name" placeholder="save current as…" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          <button disabled={!saveName.trim()} onClick={() => { const name = saveName.trim(); setProfiles((ps) => [...ps.filter((p) => p.name !== name), { name, settings: s }]); applyProfile(name); setSaveName(''); flash(`Saved profile "${name}"`); }}>Save</button>
          <button onClick={() => downloadText(`airlock-profile-${(activeProfile || 'current').replace(/\W+/g, '-')}.json`, exportProfile(activeProfile || 'Current', s))}>Export JSON</button>
          <button onClick={() => fileRef.current?.click()}>Import JSON</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              const p = parseProfile(await f.text());
              setProfiles((ps) => [...ps.filter((x) => x.name !== p.name), { name: p.name, settings: p.settings }]);
              // make it the active profile ("Update profile" must not overwrite the previous one), then
              // apply the imported settings last: applyProfile may still see an older profile of that name
              applyProfile(p.name);
              up((x) => mergeSettings(defaultSettings(x.region), p.settings));
              flash(`Imported profile "${p.name}"`);
            } catch (err) {
              flash('Import failed: ' + (err as Error).message);
            }
          }} />
          <span className="small muted">{msg}</span>
        </div>
        <p className="small muted">● built-in presets. Profiles are plain JSON, so a security team can hand one standard profile to everybody.</p>
      </section>

      <section className="panel">
        <h2>General</h2>
        <div className="row">
          <label>Global sensitivity <select value={s.sensitivity} onChange={(e) => up((x) => ({ ...x, sensitivity: e.target.value as Sensitivity }))}>{SENS.map((v) => <option key={v}>{v}</option>)}</select></label>
          <label>Phone region <RegionInput value={s.region} onCommit={(region) => up((x) => ({ ...x, region }))} /></label>
          <button onClick={() => up((x) => defaultSettings(x.region))}>Reset all settings</button>
        </div>
        <p className="small muted"><b>Strict</b>: validated or known formats only. <b>Balanced</b>: adds context rules (names, assignments, prose). <b>Aggressive</b>: adds entropy and password-shape heuristics.</p>
        <div className="row wrap">
          <span>Do not flag as unknown secrets:</span>
          {(Object.keys(s.exclusions) as (keyof Settings['exclusions'])[]).map((k) => (
            <label key={k}><input type="checkbox" checked={s.exclusions[k]} onChange={(e) => up((x) => ({ ...x, exclusions: { ...x.exclusions, [k]: e.target.checked } }))} /> {({ uuid: 'UUIDs', gitSha: 'git SHAs', hashes: 'hashes next to hash/sha/checksum', dataUri: 'base64 images / data URIs', cssColor: 'CSS colors', version: 'version strings' })[k]}</label>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Categories and detectors</h2>
        <table className="grid">
          <thead><tr><th>Category / detector</th><th>On</th><th>Sensitivity</th><th>Scopes</th><th>Placeholder</th></tr></thead>
          <tbody>
            {CATEGORIES.map((c) => {
              const dets = DETECTOR_META.filter((d) => d.category === c);
              if (!dets.length) return null;
              return [
                <tr key={c} className="cathead">
                  <td><b>{c}</b></td>
                  <td><input type="checkbox" aria-label={`${c} enabled`} checked={s.categories[c].enabled} onChange={(e) => setCat(c, { enabled: e.target.checked })} /></td>
                  <td><select aria-label={`${c} sensitivity`} value={s.categories[c].sensitivity ?? ''} onChange={(e) => setCat(c, { sensitivity: (e.target.value || undefined) as Sensitivity | undefined })}><option value="">global ({s.sensitivity})</option>{SENS.map((v) => <option key={v}>{v}</option>)}</select></td>
                  <td />
                  <td><select aria-label={`${c} placeholder`} value={s.categories[c].style ?? ''} onChange={(e) => setCat(c, { style: (e.target.value || undefined) as PlaceholderStyle | undefined })}><option value="">token</option>{STYLES.map((v) => <option key={v} value={v}>{STYLE_HELP[v]}</option>)}</select></td>
                </tr>,
                ...dets.map((d) => {
                  const o = s.detectors[d.id] ?? {};
                  const scopes = o.scopes ?? d.defaultScopes;
                  return (
                    <tr key={d.id}>
                      <td className="indent">{d.label}{d.tier === 2 ? <span className="small muted"> (tier 2)</span> : null}</td>
                      <td><input type="checkbox" aria-label={`${d.id} enabled`} checked={o.enabled ?? true} onChange={(e) => setDet(d.id, { enabled: e.target.checked ? undefined : false })} /></td>
                      <td><select aria-label={`${d.id} sensitivity`} value={o.sensitivity ?? ''} onChange={(e) => setDet(d.id, { sensitivity: (e.target.value || undefined) as Sensitivity | undefined })}><option value="">inherit</option>{SENS.map((v) => <option key={v}>{v}</option>)}</select></td>
                      <td className="scopes">{SCOPES.map((sc) => (
                        <label key={sc} className={sc === 'identifier' || sc === 'key' ? 'scope risky' : 'scope'} title={sc === 'identifier' || sc === 'key' ? 'Off by default: masking names would change code/data structure' : ''}>
                          <input type="checkbox" checked={scopes.includes(sc)} onChange={(e) => { const next = e.target.checked ? [...scopes, sc] : scopes.filter((x) => x !== sc); setDet(d.id, { scopes: next as Scope[] }); }} />{sc}
                        </label>
                      ))}</td>
                      <td><select aria-label={`${d.id} placeholder`} value={o.style ?? ''} onChange={(e) => setDet(d.id, { style: (e.target.value || undefined) as PlaceholderStyle | undefined })}><option value="">inherit</option>{STYLES.map((v) => <option key={v} value={v}>{STYLE_HELP[v]}</option>)}</select></td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Network, names and IDs</h2>
        <div className="row wrap">
          <label><input type="checkbox" checked={opt(s, 'ipPrivate', true)} onChange={(e) => up((x) => ({ ...x, options: { ...x.options, ipPrivate: e.target.checked } }))} /> mask private IP ranges (10/8, 172.16/12, 192.168/16, link-local)</label>
          <label><input type="checkbox" checked={opt(s, 'ipLocalhost', false)} onChange={(e) => up((x) => ({ ...x, options: { ...x.options, ipLocalhost: e.target.checked } }))} /> mask localhost / loopback (127.0.0.1, ::1)</label>
        </div>
        <div className="cols">
          <label>Internal host suffixes, one per line (a.b.<i>suffix</i> is masked)
            <Lines label="host suffixes" rows={4} value={opt(s, 'hostSuffixes', DEFAULT_HOST_SUFFIXES)} onCommit={(v) => up((x) => ({ ...x, options: { ...x.options, hostSuffixes: v } }))} />
          </label>
          <label>Company domains, one per line (the domain and all its sub-domains are masked)
            <Lines label="company domains" rows={4} value={opt(s, 'companyDomains', [] as string[])} onCommit={(v) => up((x) => ({ ...x, options: { ...x.options, companyDomains: v } }))} placeholder="acme-industries.com" />
          </label>
        </div>
        <div className="row wrap">
          <span>National ID packs:</span>
          {ID_PACK_META.map((p) => {
            const off = opt(s, 'idPacksOff', [] as string[]);
            return (
              <label key={p.id}>
                <input type="checkbox" checked={!off.includes(p.id)} onChange={(e) => up((x) => ({ ...x, options: { ...x.options, idPacksOff: e.target.checked ? off.filter((i) => i !== p.id) : [...off, p.id] } }))} /> {p.label}
              </label>
            );
          })}
        </div>
        <p className="small muted">Person names need a cue (greeting, signature, title, mail header, label, an email address that contains the name) unless you pick <b>aggressive</b> for “Person names”.</p>
      </section>

      <section className="panel">
        <h2>Allowlist (never mask)</h2>
        <div className="cols">
          <label>Terms, one per line (matched as whole words inside a finding, case-insensitive)
            <Lines label="allowlist terms" value={s.allowlist.terms} onCommit={(v) => up((x) => ({ ...x, allowlist: { ...x.allowlist, terms: v } }))} placeholder="example.com&#10;www.mycompany.com" />
          </label>
          <label>Regular expressions, one per line
            <Lines
              label="allowlist regexes"
              value={s.allowlist.regexes}
              onCommit={(v) => {
                const why = (r: string) => {
                  try {
                    new RegExp(r);
                  } catch (e) {
                    return (e as Error).message;
                  }
                  return regexRisk(r);
                };
                const bad = v.map((r) => [r, why(r)] as const).filter(([, w]) => w);
                if (bad.length) flash(`Not used: ${bad.map(([r, w]) => `${r} (${w})`).join('; ')}`);
                up((x) => ({ ...x, allowlist: { ...x.allowlist, regexes: v.filter((r) => !why(r)) } }));
              }}
              placeholder="^test_.*@corp\.com$"
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Always-mask lists</h2>
        <p className="small muted">Clients, projects, products, employees… Matching ignores case. Names inside code identifiers are only masked if you also switch on the <i>identifier</i> scope for “Always-mask lists” above; the result stays a valid identifier (Client1Service). Lists are stored unencrypted in this browser.</p>
        {s.customLists.map((l, i) => (
          <div key={l.id} className="listbox">
            <div className="row">
              <input aria-label="list name" value={l.name} onChange={(e) => up((x) => ({ ...x, customLists: x.customLists.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) }))} />
              <label>placeholder type <input className="short" aria-label="list type" defaultValue={l.type} onBlur={(e) => { const t = typeName(e.target.value); e.target.value = t; up((x) => ({ ...x, customLists: x.customLists.map((y, j) => (j === i ? { ...y, type: t } : y)) })); }} /></label>
              <label><input type="checkbox" checked={l.enabled} onChange={(e) => up((x) => ({ ...x, customLists: x.customLists.map((y, j) => (j === i ? { ...y, enabled: e.target.checked } : y)) }))} /> on</label>
              <span className="small muted">{l.terms.length} terms</span>
              <label className="btnlike">Import CSV/TXT<input type="file" accept=".csv,.txt,text/plain,text/csv" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                const terms = parseTerms(await f.text());
                up((x) => ({ ...x, customLists: x.customLists.map((y, j) => (j === i ? { ...y, terms: [...new Set([...y.terms, ...terms])] } : y)) }));
              }} /></label>
              <button onClick={() => up((x) => ({ ...x, customLists: x.customLists.filter((_, j) => j !== i) }))}>Remove list</button>
            </div>
            <Lines label={`terms of ${l.name}`} rows={4} value={l.terms} onCommit={(v) => up((x) => ({ ...x, customLists: x.customLists.map((y, j) => (j === i ? { ...y, terms: v } : y)) }))} />
          </div>
        ))}
        <button onClick={() => up((x) => ({ ...x, customLists: [...x.customLists, { id: 'l' + Date.now(), name: 'Clients', type: 'CLIENT', terms: [], enabled: true }] }))}>+ Add list</button>
      </section>

      <RegexRules rules={s.regexRules} onChange={(r) => up((x) => ({ ...x, regexRules: r }))} />

      <section className="panel">
        <h2>Cue words for secrets</h2>
        <p className="small muted">A value next to a name containing one of these words is treated as a secret (English, German, French, Spanish, Italian, Polish, Czech). Names that also contain a qualifier (<i>hash, length, file, url…</i>) are not.</p>
        <div className="cols">
          <label>Cue words<Lines label="cue words" rows={10} value={s.keywords} onCommit={(v) => up((x) => ({ ...x, keywords: v }))} /></label>
          <label>Qualifiers (cancel a cue)<Lines label="qualifiers" rows={10} value={s.qualifiers} onCommit={(v) => up((x) => ({ ...x, qualifiers: v }))} /></label>
        </div>
        <button onClick={() => up((x) => ({ ...x, keywords: [...DEFAULT_KEYWORDS], qualifiers: [...DEFAULT_QUALIFIERS] }))}>Reset both lists</button>
      </section>
    </div>
  );
}

function RegexRules({ rules, onChange }: { rules: RegexRule[]; onChange(r: RegexRule[]): void }) {
  const set = (i: number, p: Partial<RegexRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <section className="panel">
      <h2>Your regex rules</h2>
      <p className="small muted">Patterns with nested quantifiers (like <code>(a+)+</code>) are refused. If group 1 exists, only the group is masked.</p>
      {rules.map((r, i) => <RuleRow key={r.id} r={r} set={(p) => set(i, p)} remove={() => onChange(rules.filter((_, j) => j !== i))} />)}
      <button onClick={() => onChange([...rules, { id: 'r' + Date.now(), name: 'Order numbers', type: 'ORDER', pattern: 'ORD-\\d{6}', flags: 'i', enabled: true }])}>+ Add rule</button>
    </section>
  );
}

function RuleRow({ r, set, remove }: { r: RegexRule; set(p: Partial<RegexRule>): void; remove(): void }) {
  const [sample, setSample] = useState('');
  const [res, setRes] = useState<RegexTestRes | null>(null);
  useEffect(() => {
    if (!sample) return setRes(null);
    const t = setTimeout(() => {
      engine
        .call<RegexTestRes>({ type: 'regex', pattern: r.pattern, flags: r.flags, sample }, { timeoutMs: 1500 })
        .then(setRes)
        .catch((e: Error) => setRes({ error: e instanceof CancelledError ? 'The pattern took too long and was stopped.' : e.message, matches: [] }));
    }, 300);
    return () => clearTimeout(t);
  }, [sample, r.pattern, r.flags]);
  const parts: ReactNode[] = [];
  if (res && !res.error) {
    let pos = 0;
    for (const [a, b] of res.matches) {
      if (a < pos) continue;
      parts.push(<span key={'a' + a}>{sample.slice(pos, a)}</span>, <mark key={'m' + a} className="hl cat-custom">{sample.slice(a, b)}</mark>);
      pos = b;
    }
    parts.push(<span key="end">{sample.slice(pos)}</span>);
  }
  return (
    <div className="listbox">
      <div className="row">
        <input aria-label="rule name" value={r.name} onChange={(e) => set({ name: e.target.value })} />
        <label>type <input className="short" aria-label="rule type" defaultValue={r.type} onBlur={(e) => { const t = typeName(e.target.value); e.target.value = t; set({ type: t }); }} /></label>
        <input aria-label="pattern" className="mono grow" value={r.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="regular expression" />
        <input aria-label="flags" className="short" value={r.flags} maxLength={4} onChange={(e) => set({ flags: e.target.value })} placeholder="flags" />
        <label><input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> on</label>
        <button onClick={remove}>Remove</button>
      </div>
      <textarea aria-label="test text" className="lines" rows={2} value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Live test: type or paste sample text here" />
      {res && (res.error ? <div className="warntext small">{res.error}</div> : <pre className="review small">{parts}</pre>)}
      {res && !res.error && <div className="small muted">{res.matches.length} match{res.matches.length === 1 ? '' : 'es'}</div>}
    </div>
  );
}
