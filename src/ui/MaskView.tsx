import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { Hit, Settings } from '../engine/light';
import { hitKey, selectedHits, type DocState } from './types';
import { copyText } from './util';

interface Props {
  docs: DocState[];
  active: DocState;
  busy: boolean;
  settings: Settings;
  onSelect(id: string): void;
  onText(id: string, text: string): void;
  onEditing(id: string, editing: boolean): void;
  onFiles(files: FileList | File[]): void;
  onAdd(): void;
  onRemove(id: string): void;
  onKeepOnce(d: DocState, h: Hit): void;
  onUnkeep(d: DocState, h: Hit): void;
  onAlwaysKeep(d: DocState, h: Hit): void;
  onMaskOnce(d: DocState, start: number, end: number, type: string): void;
  onMaskAlways(d: DocState, start: number, end: number, type: string): void;
  onRetry(id: string): void;
  onCancel(): void;
}

const LOW = 0.7;
const LINES = 400;
const TYPES = ['CUSTOM', 'CLIENT', 'PROJECT', 'PRODUCT', 'EMPLOYEE', 'PERSON', 'PASSWORD', 'SECRET', 'EMAIL'];

function lineLimit(text: string, lines: number): number {
  let pos = 0;
  for (let i = 0; i < lines; i++) {
    const n = text.indexOf('\n', pos);
    if (n < 0) return text.length;
    pos = n + 1;
  }
  return pos;
}

/** Enter / Space on a focusable non-button element */
function activate(e: KeyboardEvent, f: () => void) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    f();
  }
}

function offsetIn(node: Node, off: number): number | null {
  const el = (node.nodeType === 3 ? node.parentElement : (node as Element))?.closest<HTMLElement>('[data-s]');
  if (!el) return null;
  const base = Number(el.dataset.s);
  if (node.nodeType === 3) return base + off;
  return base + (off > 0 ? (el.textContent ?? '').length : 0);
}

export function MaskView(p: Props) {
  const { active: d } = p;
  const [sel, setSel] = useState<string | null>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [type, setType] = useState('CUSTOM');
  const [limit, setLimit] = useState(LINES);
  const [lowOnly, setLowOnly] = useState(false);
  const [copied, setCopied] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const chosen = useMemo(() => selectedHits(d), [d]);
  const kept = useMemo(() => new Set(d.keep), [d.keep]);
  const all = useMemo(() => [...d.hits, ...d.extra].sort((a, b) => a.start - b.start), [d.hits, d.extra]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of chosen) m.set(h.type, (m.get(h.type) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [chosen]);
  const low = useMemo(() => chosen.filter((h) => h.confidence < LOW), [chosen]);
  const selHit = sel ? all.find((h) => hitKey(d.text, h) === sel) : undefined;
  const res = d.result;
  /** the masked output belongs to the current text and choices */
  const fresh = !!res && d.status === 'ready' && d.maskedVer === d.mver;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) p.onFiles(e.dataTransfer.files);
    else {
      const t = e.dataTransfer.getData('text/plain');
      if (t) p.onText(d.id, t);
    }
  };

  const copy = async (what: string, text: string) => {
    const ok = await copyText(text);
    setCopied(ok ? what : 'copy failed');
    setTimeout(() => setCopied(''), 1800);
  };

  const text = d.text;
  const end = lineLimit(text, limit);
  const reviewNodes: ReactNode[] = [];
  {
    let pos = 0;
    for (const h of all) {
      if (h.start >= end) break;
      if (h.start < pos) continue;
      if (h.start > pos) reviewNodes.push(<span key={'t' + pos} data-s={pos}>{text.slice(pos, h.start)}</span>);
      const k = hitKey(text, h);
      const isKept = kept.has(k);
      const cls = ['hl', 'cat-' + h.category, isKept ? 'kept' : '', h.confidence < LOW ? 'low' : '', k === sel ? 'sel' : ''].join(' ');
      reviewNodes.push(
        <mark
          key={'h' + h.start}
          data-s={h.start}
          className={cls}
          title={`${h.type} · ${Math.round(h.confidence * 100)}% · ${h.reason}`}
          tabIndex={0}
          role="button"
          aria-pressed={k === sel}
          aria-label={`${h.type}${isKept ? ', kept' : ''}: ${text.slice(h.start, h.end).slice(0, 60)}`}
          onClick={() => setSel(k === sel ? null : k)}
          onKeyDown={(e) => activate(e, () => setSel(k === sel ? null : k))}
        >
          {text.slice(h.start, h.end)}
        </mark>,
      );
      pos = h.end;
    }
    if (pos < end) reviewNodes.push(<span key={'t' + pos} data-s={pos}>{text.slice(pos, end)}</span>);
  }

  const outNodes: ReactNode[] = [];
  if (res) {
    const out = res.output;
    const oend = lineLimit(out, limit);
    let pos = 0;
    for (const r of res.replacements) {
      if (r.outStart >= oend) break;
      if (r.outStart > pos) outNodes.push(<span key={'o' + pos}>{out.slice(pos, r.outStart)}</span>);
      outNodes.push(<mark key={'p' + r.outStart} className={'ph cat-' + r.hit.category}>{out.slice(r.outStart, r.outEnd)}</mark>);
      pos = r.outEnd;
    }
    if (pos < oend) outNodes.push(<span key={'o' + pos}>{out.slice(pos, oend)}</span>);
  }

  const onMouseUp = () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return setRange(null);
    const r = s.getRangeAt(0);
    const a = offsetIn(r.startContainer, r.startOffset);
    const b = offsetIn(r.endContainer, r.endOffset);
    if (a == null || b == null || a === b) return setRange(null);
    setRange({ start: Math.min(a, b), end: Math.max(a, b) });
  };

  const shownRows = (lowOnly ? all.filter((h) => h.confidence < LOW) : all).slice(0, 300);
  const totalMore = text.length > end;

  return (
    <div>
      <div className="docbar">
        {p.docs.map((x) => (
          <span key={x.id} className={x.id === d.id ? 'doc on' : 'doc'}>
            <button className="link" onClick={() => p.onSelect(x.id)}>{x.name}</button>
            {(p.docs.length > 1 || x.text) && <button className="x" aria-label={`remove ${x.name}`} onClick={() => p.onRemove(x.id)}>×</button>}
          </span>
        ))}
        <button onClick={p.onAdd}>+ paste</button>
        <button onClick={() => fileRef.current?.click()}>Add files…</button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => e.target.files && p.onFiles(e.target.files)} />
        <div className="grow" />
        {p.busy && <button onClick={p.onCancel}>Cancel</button>}
        <span className="small muted">{d.status === 'analyzing' ? 'detecting…' : d.format ? `${d.format}${d.lang ? ' / ' + d.lang : ''}${d.ms != null ? ` · ${d.ms} ms` : ''}` : ''}</span>
      </div>

      <div className="summary">
        {counts.length === 0 && <span className="muted small">{d.status === 'ready' ? 'Nothing sensitive found.' : 'Paste or drop text, config, code or logs below.'}</span>}
        {counts.map(([t, n]) => <span key={t} className="chip">{t} <b>{n}</b></span>)}
        {low.length > 0 && <button className={lowOnly ? 'chip warn on' : 'chip warn'} onClick={() => setLowOnly(!lowOnly)}>{low.length} to review (low confidence)</button>}
        {res && (
          <span className={res.guard.ok && res.skipped.length === 0 ? 'chip ok' : 'chip warn'} title={res.guard.issues.join('\n')}>
            {res.guard.checked ? 'Structure guard: ' : 'Structure guard: n/a (plain text) · '}
            {res.guard.ok ? (res.skipped.length ? `OK, ${res.skipped.length} skipped for review` : 'OK') : 'FAILED'}
          </span>
        )}
      </div>

      {d.error && <div className="notice error">{d.error} <button className="link" onClick={() => p.onRetry(d.id)}>Detect again</button></div>}

      <div className="cols">
        <section className={drag ? 'panel drop' : 'panel'} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          <div className="panelhead">
            <h2>Original</h2>
            <div className="grow" />
            {d.text && <button onClick={() => p.onEditing(d.id, !d.editing)}>{d.editing ? 'Review highlights' : 'Edit text'}</button>}
          </div>
          {d.editing || !d.text ? (
            <textarea
              className="editor"
              aria-label="Text to mask"
              placeholder="Paste text, code, config or logs here, or drop files onto this panel"
              value={d.text}
              spellCheck={false}
              onChange={(e) => p.onText(d.id, e.target.value)}
              onPaste={() => { if (!d.text) setTimeout(() => p.onEditing(d.id, false), 700); }}
            />
          ) : (
            <pre className="review" onMouseUp={onMouseUp}>{reviewNodes}</pre>
          )}
          {totalMore && !d.editing && <button className="more" onClick={() => setLimit(limit + 2000)}>Show more lines ({Math.round((100 * end) / text.length)}% shown; the masked output always covers everything)</button>}
          {range && !d.editing && (
            <div className="selbar">
              <span className="mono">“{text.slice(range.start, range.end).slice(0, 40)}”</span>
              <select value={type} onChange={(e) => setType(e.target.value)} aria-label="type for selection">{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
              <button onClick={() => { p.onMaskOnce(d, range.start, range.end, type); setRange(null); window.getSelection()?.removeAllRanges(); }}>Mask once</button>
              <button onClick={() => { p.onMaskAlways(d, range.start, range.end, type); setRange(null); window.getSelection()?.removeAllRanges(); }}>Mask always</button>
            </div>
          )}
          {selHit && (
            <div className="detail">
              <div><span className={'chip cat-' + selHit.category}>{selHit.type}</span> <b>{Math.round(selHit.confidence * 100)}%</b> confidence · scope <i>{selHit.scope ?? 'n/a'}</i></div>
              <div className="mono val">{text.slice(selHit.start, selHit.end).slice(0, 120)}</div>
              <div>{selHit.reason}</div>
              <div className="row">
                {kept.has(sel!) ? <button onClick={() => p.onUnkeep(d, selHit)}>Mask this again</button> : <button onClick={() => p.onKeepOnce(d, selHit)}>Keep (this time)</button>}
                <button onClick={() => p.onAlwaysKeep(d, selHit)}>Always keep</button>
              </div>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panelhead">
            <h2>Masked output</h2>
            <div className="grow" />
            <span className="small muted" aria-live="polite">{copied}</span>
            <button className="primary" disabled={!fresh} title={res && !fresh ? 'Updating: the output does not match the text yet' : undefined} onClick={() => fresh && copy('Copied masked text', res.output)}>Copy masked</button>
            {p.docs.length > 1 && (
              <button
                disabled={!p.docs.every((x) => !x.text.trim() || (x.result && x.status === 'ready' && x.maskedVer === x.mver))}
                onClick={() => copy('Copied all', p.docs.filter((x) => x.text.trim()).map((x) => `=== ${x.name} ===\n${x.result?.output ?? ''}`).join('\n\n'))}
              >
                Copy all
              </button>
            )}
          </div>
          {res ? <pre className={fresh ? 'out' : 'out stale'} aria-busy={!fresh}>{outNodes}</pre> : <pre className="out muted">{d.status === 'analyzing' ? 'Detecting…' : 'The masked text appears here.'}</pre>}
          {res && res.skipped.length > 0 && (
            <div className="notice">
              {res.skipped.length} finding(s) were left unmasked because masking them would break the structure (flagged for review):
              <ul>{res.skipped.slice(0, 8).map((h) => <li key={h.start} className="mono">{h.type}: {text.slice(h.start, h.end).slice(0, 40)}</li>)}</ul>
            </div>
          )}
        </section>
      </div>

      {all.length > 0 && (
        <section className="panel">
          <div className="panelhead"><h2>Findings ({all.length})</h2><div className="grow" /><span className="small muted">click a row or a highlight for details</span></div>
          <table className="findings">
            <thead><tr><th>Type</th><th>Text</th><th>Conf.</th><th>Why</th><th /></tr></thead>
            <tbody>
              {shownRows.map((h) => {
                const k = hitKey(text, h);
                return (
                  <tr
                    key={h.start + ':' + h.end}
                    className={(k === sel ? 'sel ' : '') + (kept.has(k) ? 'kept' : '')}
                    tabIndex={0}
                    aria-selected={k === sel}
                    onClick={() => { setSel(k); p.onEditing(d.id, false); }}
                    onKeyDown={(e) => e.target === e.currentTarget && activate(e, () => { setSel(k); p.onEditing(d.id, false); })}
                  >
                    <td><span className={'chip cat-' + h.category}>{h.type}</span></td>
                    <td className="mono">{text.slice(h.start, h.end).slice(0, 50)}</td>
                    <td className={h.confidence < LOW ? 'warntext' : ''}>{Math.round(h.confidence * 100)}%</td>
                    <td>{h.reason}</td>
                    <td>{kept.has(k) ? <button onClick={(e) => { e.stopPropagation(); p.onUnkeep(d, h); }}>mask</button> : <button onClick={(e) => { e.stopPropagation(); p.onKeepOnce(d, h); }}>keep</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {all.length > shownRows.length && <div className="small muted">showing the first {shownRows.length} rows</div>}
        </section>
      )}
    </div>
  );
}
