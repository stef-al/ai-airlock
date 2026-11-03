import type { OfficePicture } from '../media/officedoc';
import type { DocState } from './types';

export interface OfficeOps {
  /** the file's pictures, their image documents and whether each one is ready for the copy */
  pictures(d: DocState): { pic: OfficePicture; child?: DocState; ready: boolean }[];
  open(id: string): void;
  download(d: DocState): void;
}

const KIND: Record<string, string> = { docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel' };

/** Under the text review of a Word, PowerPoint or Excel file: its pictures, the copy, the report. */
export function OfficeReview({ d, ops, fresh }: { d: DocState; ops: OfficeOps; fresh: boolean }) {
  const st = d.office!;
  const f = st.file;
  const r = f?.report;
  const pics = ops.pictures(d);
  const pending = pics.filter((p) => !p.ready);
  const can = fresh && !!f && pending.length === 0;
  const short = (v: string) => (v.length > 40 ? v.slice(0, 40) + '…' : v);
  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Redacted {f ? KIND[f.kind] : 'Office'} file</h2>
        <div className="grow" />
        <button className="primary" disabled={!can} onClick={() => ops.download(d)} title={pending.length ? 'Every picture has to be redacted and reviewed first' : undefined}>
          Download redacted copy
        </button>
      </div>
      {pics.length > 0 && (
        <div className="small">
          {pics.length} picture{pics.length > 1 ? 's' : ''}, each redacted as an image{pending.length ? `: ${pending.length} still to redact or review` : ': all ready'}.{' '}
          {pics.map((p) => (
            <button key={p.pic.path} className={p.ready ? 'chip ok' : 'chip warn'} disabled={!p.child} onClick={() => p.child && ops.open(p.child.id)}>
              {p.pic.name} {p.ready ? '✓' : '…'}
            </button>
          ))}
        </div>
      )}
      {f && r && (
        <ul className="report small">
          <li>The copy keeps the layout: each masked value is replaced in the file's own text, with its placeholder.</li>
          {r.properties.length > 0 && <li>Document properties emptied: {r.properties.map(([k, v]) => `${k} “${short(v)}”`).join(', ')}.</li>}
          {r.thumbnail && <li>The preview picture of the first page is removed.</li>}
          {r.authors.length > 0 && <li>Authors of comments and changes renamed: {r.authors.map((a, i) => `${short(a)} → Author ${i + 1}`).join(', ')}.</li>}
          {r.changes.insertions + r.changes.deletions + r.changes.formatting > 0 && (
            <li>Tracked changes accepted: {r.changes.insertions} insertion{r.changes.insertions === 1 ? '' : 's'} kept, {r.changes.deletions} deletion{r.changes.deletions === 1 ? '' : 's'} removed with their text{r.changes.formatting ? `, ${r.changes.formatting} formatting change records removed` : ''}.</li>
          )}
          {r.macros && <li>Macros removed.</li>}
          {r.removed.filter((p) => /printerSettings/i.test(p)).length > 0 && <li>Printer settings removed.</li>}
          {f.embedded.size > 0 && <li>Embedded files masked the same way: {[...f.embedded.keys()].map((k) => k.replace(/^.*\//, '')).join(', ')}.</li>}
          {r.blanked.length + st.blanks.length > 0 && <li className="warntext">Replaced by blanks because they cannot be checked here: {[...r.blanked, ...st.blanks].map((k) => k.replace(/^.*[/>]/, '')).join(', ')}.</li>}
        </ul>
      )}
    </section>
  );
}
