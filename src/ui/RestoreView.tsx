import { useEffect, useState } from 'react';
import { Mapping, restoreText, type MappingSnapshot, type RestoreReport } from '../engine/light';
import { copyText } from './util';

export function RestoreView({ mapping, expected }: { mapping?: MappingSnapshot; expected: string[] }) {
  const [reply, setReply] = useState('');
  const [rep, setRep] = useState<RestoreReport | null>(null);
  const [copied, setCopied] = useState('');
  const count = mapping?.entries.length ?? 0;

  useEffect(() => {
    if (!reply) return setRep(null);
    const t = setTimeout(() => setRep(restoreText(reply, Mapping.from(mapping), expected)), 150);
    return () => clearTimeout(t);
  }, [reply, mapping, expected]);

  return (
    <div>
      <p className="muted">Paste the chatbot's reply. Placeholders such as <code>[PASSWORD_1]</code>, <code>PASSWORD_1</code>, <code>`password_1`</code> or fake emails are replaced with the original values. {count === 0 && <b>Nothing is in memory yet: mask something first.</b>}</p>
      <div className="cols">
        <section className="panel">
          <div className="panelhead"><h2>AI reply</h2></div>
          <textarea className="editor" aria-label="AI reply" placeholder="Paste the AI's reply here" value={reply} spellCheck={false} onChange={(e) => setReply(e.target.value)} />
        </section>
        <section className="panel">
          <div className="panelhead">
            <h2>Restored</h2>
            <div className="grow" />
            <span className="small muted">{copied}</span>
            <button className="primary" disabled={!rep} onClick={async () => { setCopied((await copyText(rep!.output)) ? 'Copied' : 'copy failed'); setTimeout(() => setCopied(''), 1800); }}>Copy restored</button>
          </div>
          <pre className="out">{rep ? rep.output : <span className="muted">The restored text appears here.</span>}</pre>
        </section>
      </div>
      {rep && (
        <section className="panel report">
          <h2>Report</h2>
          <p><b>{rep.total}</b> placeholder{rep.total === 1 ? '' : 's'} restored{rep.restored.length ? ': ' : '.'}{rep.restored.map((r) => <span key={r.id} className="chip ok">{r.id}{r.count > 1 ? ` ×${r.count}` : ''}</span>)}</p>
          <p><b>{rep.missing.length}</b> from your masked text did not come back{rep.missing.length ? ': ' : '.'}{rep.missing.map((id) => <span key={id} className="chip warn">{id}</span>)}</p>
          <p><b>{rep.unknown.length}</b> unknown placeholder{rep.unknown.length === 1 ? '' : 's'} (invented by the AI or from another session){rep.unknown.length ? ': ' : '.'}{rep.unknown.map((id) => <span key={id} className="chip warn">{id}</span>)}</p>
        </section>
      )}
    </div>
  );
}
