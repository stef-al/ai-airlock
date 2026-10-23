import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUILTIN_PROFILES, defaultSettings, mergeSettings, regionFromLocale, type MappingSnapshot, type Profile, type Settings } from '../engine/light';
import type { AnalyzeRes, MaskRes } from '../worker/protocol';
import { CancelledError, engine } from './engineClient';
import { MaskView } from './MaskView';
import { RestoreView } from './RestoreView';
import { SettingsView } from './SettingsView';
import { loadActive, loadProfiles, loadSettings, saveActive, saveProfiles, saveSettings } from './store';
import { hitKey, selectedHits, type DocState } from './types';
import { readFileText } from './util';

type Tab = 'mask' | 'restore' | 'settings' | 'about';
let nextId = 1;
const newDoc = (name = 'pasted text', text = ''): DocState => ({
  id: 'd' + nextId++, name, text, ver: 1, editing: true, status: 'idle', hits: [], keep: [], extra: [], mver: 0, maskedVer: -1,
});

export function App() {
  const [tab, setTab] = useState<Tab>('mask');
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [profiles, setProfiles] = useState<Profile[]>(loadProfiles);
  const [activeProfile, setActiveProfile] = useState<string>(loadActive);
  const [docs, setDocs] = useState<DocState[]>(() => [newDoc()]);
  const [activeId, setActiveId] = useState<string>(() => 'd' + (nextId - 1));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [mapCount, setMapCount] = useState(0);

  // every change goes through updateDocs, so the ref is current even before React re-renders
  // (an analysis scheduled right after adding a file must find it)
  const docsRef = useRef(docs);
  const updateDocs = useCallback((f: (ds: DocState[]) => DocState[]) => {
    docsRef.current = f(docsRef.current);
    setDocs(docsRef.current);
  }, []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const mappingRef = useRef<MappingSnapshot | undefined>(undefined);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const masking = useRef(new Set<string>());

  useEffect(() => engine.subscribe(setBusy), []);

  const patch = useCallback((id: string, p: Partial<DocState>) => updateDocs((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d))), [updateDocs]);

  const runAnalyze = useCallback(
    async (id: string) => {
      const d = docsRef.current.find((x) => x.id === id);
      if (!d) return;
      if (!d.text.trim()) {
        patch(id, { status: 'idle', hits: [], result: undefined, keep: [], mver: d.mver + 1, maskedVer: d.mver + 1 });
        return;
      }
      patch(id, { status: 'analyzing', error: undefined });
      const ver = d.ver;
      try {
        const res = await engine.call<AnalyzeRes>({ type: 'analyze', docKey: id, text: d.text, settings: settingsRef.current, fileName: d.name === 'pasted text' ? undefined : d.name });
        const cur = docsRef.current.find((x) => x.id === id);
        if (!cur || cur.ver !== ver) return;
        const valid = new Set(res.hits.map((h) => hitKey(cur.text, h)));
        patch(id, { hits: res.hits, format: res.format, lang: res.lang, ms: res.ms, status: 'ready', keep: cur.keep.filter((k) => valid.has(k)), mver: cur.mver + 1 });
      } catch (e) {
        if (e instanceof CancelledError) patch(id, { status: 'idle', error: e.message });
        else patch(id, { status: 'error', error: (e as Error).message });
      }
    },
    [patch],
  );

  const scheduleAnalyze = useCallback(
    (id: string, delay = 350) => {
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void runAnalyze(id);
        }, delay),
      );
    },
    [runAnalyze],
  );

  // masking: whenever findings / user choices changed
  useEffect(() => {
    for (const d of docs) {
      if (d.status !== 'ready' || d.maskedVer === d.mver || masking.current.has(d.id)) continue;
      masking.current.add(d.id);
      const mver = d.mver;
      const hits = selectedHits(d);
      engine
        .call<MaskRes>(
          () => ({
            type: 'mask', docKey: d.id, text: d.text, settings: settingsRef.current, fileName: d.name === 'pasted text' ? undefined : d.name,
            format: d.format ?? 'prose', lang: d.lang, hits, mapping: mappingRef.current ?? { entries: [], counters: [], reservedIds: [], reservedFakes: [] },
          }),
          // the session mapping must be updated before the next queued mask job reads it
          { onResult: (res) => void (mappingRef.current = res.mapping) },
        )
        .then((res) => {
          setMapCount(res.mapping.entries.length);
          updateDocs((ds) => ds.map((x) => (x.id === d.id && x.mver === mver ? { ...x, result: res, maskedVer: mver } : x)));
        })
        .catch((e: Error) => {
          if (!(e instanceof CancelledError)) updateDocs((ds) => ds.map((x) => (x.id === d.id ? { ...x, status: 'error', error: e.message } : x)));
        })
        .finally(() => {
          masking.current.delete(d.id);
          updateDocs((ds) => [...ds]);
        });
    }
  }, [docs, updateDocs]);

  // settings: persist, then re-analyse everything
  const firstSettings = useRef(true);
  useEffect(() => {
    saveSettings(settings);
    if (firstSettings.current) {
      firstSettings.current = false;
      return;
    }
    const t = setTimeout(() => docsRef.current.forEach((d) => d.text.trim() && scheduleAnalyze(d.id, 0)), 400);
    return () => clearTimeout(t);
  }, [settings, scheduleAnalyze]);

  useEffect(() => saveProfiles(profiles), [profiles]);
  useEffect(() => saveActive(activeProfile), [activeProfile]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if ((mappingRef.current?.entries.length ?? 0) > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const setText = (id: string, text: string) => {
    updateDocs((ds) => ds.map((d) => (d.id === id ? { ...d, text, ver: d.ver + 1, status: text.trim() ? 'analyzing' : 'idle', keep: [], extra: [] } : d)));
    scheduleAnalyze(id, text.length > 200_000 ? 800 : 350);
  };

  const addFiles = async (files: FileList | File[]) => {
    const added: DocState[] = [];
    const skipped: string[] = [];
    for (const f of Array.from(files)) {
      const r = await readFileText(f);
      if (!r.ok) {
        skipped.push(`${f.name}: ${r.reason}`);
        continue;
      }
      const d = newDoc(f.name, r.text);
      d.editing = false;
      d.status = 'analyzing';
      added.push(d);
    }
    if (skipped.length) setNotice('Skipped ' + skipped.join('; '));
    if (!added.length) return;
    updateDocs((ds) => {
      const base = ds.length === 1 && !ds[0].text.trim() ? [] : ds;
      return [...base, ...added];
    });
    setActiveId(added[0].id);
    added.forEach((d) => scheduleAnalyze(d.id, 0));
  };

  const forget = () => {
    engine.cancel('forgotten');
    mappingRef.current = undefined;
    setMapCount(0);
    const d = newDoc();
    updateDocs(() => [d]);
    setActiveId(d.id);
    setNotice('Everything forgotten: texts, findings and the placeholder mapping were cleared from memory.');
  };

  const applyProfile = (name: string) => {
    setActiveProfile(name);
    const p = [...BUILTIN_PROFILES, ...profiles].find((x) => x.name === name);
    if (p) setSettings(mergeSettings(defaultSettings(settings.region || regionFromLocale()), p.settings));
  };

  const active = docs.find((d) => d.id === activeId) ?? docs[0];
  const expected = useMemo(() => [...new Set(docs.flatMap((d) => d.result?.replacements.map((r) => r.id).filter((x): x is string => !!x) ?? []))], [docs]);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>AI Airlock</h1>
          <span className="badge offline" title="This page makes no network requests. A strict Content-Security-Policy blocks them.">offline · nothing leaves this device</span>
        </div>
        <nav className="tabs" role="tablist">
          {(['mask', 'restore', 'settings', 'about'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
              {t === 'mask' ? '1 · Mask' : t === 'restore' ? '2 · Restore' : t === 'settings' ? 'Settings' : 'About'}
            </button>
          ))}
        </nav>
        <div className="grow" />
        <span className="small muted" title="Number of distinct values currently held in memory for restoring">{mapCount} value{mapCount === 1 ? '' : 's'} in memory</span>
        <button className="danger" onClick={forget}>Forget everything</button>
      </header>
      {notice && (
        <div className="notice" role="status">
          {notice} <button className="link" onClick={() => setNotice('')}>dismiss</button>
        </div>
      )}
      {tab === 'mask' && (
        <MaskView
          docs={docs}
          active={active}
          busy={busy}
          settings={settings}
          onSelect={setActiveId}
          onText={setText}
          onEditing={(id, editing) => patch(id, { editing })}
          onFiles={addFiles}
          onAdd={() => {
            const d = newDoc();
            updateDocs((ds) => [...ds, d]);
            setActiveId(d.id);
          }}
          onRemove={(id) => {
            updateDocs((ds) => {
              const rest = ds.filter((d) => d.id !== id);
              if (!rest.length) rest.push(newDoc());
              return rest;
            });
            if (id === activeId) setActiveId(docsRef.current[0].id);
          }}
          onKeepOnce={(d, h) => patch(d.id, { keep: [...d.keep, hitKey(d.text, h)], mver: d.mver + 1 })}
          onUnkeep={(d, h) => patch(d.id, { keep: d.keep.filter((k) => k !== hitKey(d.text, h)), mver: d.mver + 1 })}
          onAlwaysKeep={(d, h) => {
            const term = d.text.slice(h.start, h.end);
            setSettings((s) => (s.allowlist.terms.includes(term) ? s : { ...s, allowlist: { ...s.allowlist, terms: [...s.allowlist.terms, term] } }));
            setNotice(`"${term.length > 40 ? term.slice(0, 40) + '…' : term}" added to the allowlist (Settings → Allowlist).`);
          }}
          onMaskOnce={(d, start, end, type) => patch(d.id, { extra: [...d.extra, { start, end, type, category: 'custom', detector: 'user', confidence: 1, reason: 'you selected this text', priority: 5, user: 'mask-once' }], mver: d.mver + 1 })}
          onMaskAlways={(d, start, end, type) => {
            const term = d.text.slice(start, end).trim();
            if (term.length < 2) return;
            setSettings((s) => {
              const lists = [...s.customLists];
              const i = lists.findIndex((l) => l.id === 'my-list-' + type);
              if (i >= 0) lists[i] = { ...lists[i], terms: [...new Set([...lists[i].terms, term])] };
              else lists.push({ id: 'my-list-' + type, name: 'My ' + type.toLowerCase() + ' list', type, terms: [term], enabled: true });
              return { ...s, customLists: lists };
            });
          }}
          onRetry={(id) => scheduleAnalyze(id, 0)}
          onCancel={() => {
            engine.cancel('Stopped.');
            updateDocs((ds) => ds.map((d) => (d.status === 'analyzing' ? { ...d, status: 'idle', error: 'Stopped. Edit the text or press Detect to try again.' } : d)));
          }}
        />
      )}
      {tab === 'restore' && <RestoreView mapping={mappingRef.current} expected={expected} />}
      {tab === 'settings' && (
        <SettingsView
          settings={settings}
          setSettings={setSettings}
          profiles={profiles}
          setProfiles={setProfiles}
          activeProfile={activeProfile}
          applyProfile={applyProfile}
        />
      )}
      {tab === 'about' && <About />}
    </div>
  );
}

function About() {
  return (
    <section className="panel prose">
      <h2>How it works</h2>
      <ol>
        <li><b>Mask</b>: paste text or drop files. Findings are highlighted; click one to see why it was flagged and to keep it. Copy the masked text into your chatbot.</li>
        <li><b>Restore</b>: paste the chatbot's reply. Placeholders are replaced by the original values again.</li>
      </ol>
      <h2>Privacy</h2>
      <ul>
        <li>No server, no analytics, no fonts or libraries loaded from anywhere. A strict Content-Security-Policy makes the browser refuse any request to another origin.</li>
        <li>Original values and the placeholder mapping exist only in this tab's memory. Closing the tab, or pressing <i>Forget everything</i>, erases them.</li>
        <li>Only your settings, profiles and always-mask lists are saved in this browser's localStorage. Those lists are stored unencrypted.</li>
      </ul>
      <h2>Limits</h2>
      <ul>
        <li>Detection is rule-based. It cannot know that an ordinary word is a secret or a name unless a cue, a format or your lists say so. Always read the masked text before pasting.</li>
        <li>Names and organisations without cues, postal addresses, and Office/PDF files are not covered yet.</li>
        <li>Chatbots may rewrite or drop placeholders; the restore report lists what did not come back.</li>
      </ul>
    </section>
  );
}
