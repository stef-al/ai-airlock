import { useEffect, useMemo, useState } from 'react';
import { opt, type Hit, type Settings } from '../engine/light';
import { spanBoxes } from '../media/ocrdoc';
import type { Box } from '../media/ocrTypes';
import type { PdfState } from '../media/pdfdoc';
import { loadMedia } from './media';
import { BOX_TYPES, CopyView, PageView, useBitmap, type Mark } from './PageView';
import { hitKey, type DocState } from './types';
import { copyText } from './util';

export interface PdfOps {
  addBox(d: DocState, page: number, box: Box, type: string): void;
  removeBox(d: DocState, index: number): void;
  setReviewed(d: DocState, v: boolean): void;
  download(d: DocState): void;
  unlock(d: DocState, password: string): void;
}

interface Props {
  d: DocState;
  settings: Settings;
  sel: string | null;
  setSel(k: string | null): void;
  ops: PdfOps;
  outputOf(d: DocState): string;
  onKeepOnce(d: DocState, h: Hit): void;
  onUnkeep(d: DocState, h: Hit): void;
}

/** The page a position of the document text is on (the offsets are sorted). */
function pageOf(st: PdfState, pos: number): number {
  let p = 0;
  for (let i = 0; i < st.offsets.length; i++) if (st.offsets[i] <= pos) p = i;
  return p;
}

/** The original page rendered for the review (about 1400 px wide at most). */
function usePagePreview(st: PdfState, page: number): ImageBitmap | null {
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const p = st.pages[page];
  useEffect(() => {
    if (!p) return;
    let alive = true;
    let made: ImageBitmap | null = null;
    void loadMedia()
      .then((m) => m.pagePreview(st, page, Math.min(2, 1400 / p.w)))
      .then((b) => {
        if (alive) setBmp((made = b));
        else b.close();
      })
      .catch(() => alive && setBmp(null));
    return () => {
      alive = false;
      made?.close();
    };
    // rendered again only for another file, password or page (not on every state change)
  }, [st.bytes, st.password, page, p?.w]);
  return bmp;
}

function Unlock({ d, ops }: { d: DocState; ops: PdfOps }) {
  const [pw, setPw] = useState('');
  return (
    <section className="panel">
      <h2>This PDF is protected by a password</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) ops.unlock(d, pw);
        }}
      >
        <input type="password" aria-label="PDF password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="primary" type="submit" disabled={!pw}>Open</button>
      </form>
      {d.pdf?.locked === 'wrong' && <div className="warntext small">That password is not correct.</div>}
      <p className="small muted">The password stays in this tab's memory, like the file. The redacted copy has no password.</p>
    </section>
  );
}

export function PdfReview({ d, settings, sel, setSel, ops, outputOf, onKeepOnce, onUnkeep }: Props) {
  const st = d.pdf!;
  const [page, setPage] = useState(0);
  const [boxType, setBoxType] = useState('AREA');
  const [msg, setMsg] = useState('');
  const pad = Number(opt(settings, 'imgPad', '0.2')) || 0.2;
  const needReview = opt(settings, 'imgReview', true);
  const n = st.pages.length;
  const cur = Math.min(page, Math.max(0, n - 1));
  const p = st.pages[cur];
  const orig = usePagePreview(st, cur);
  const outPage = st.out?.pages[cur];
  const outBmp = useBitmap(outPage?.jpeg);

  const all = useMemo(() => [...d.hits, ...d.extra].sort((a, b) => a.start - b.start), [d.hits, d.extra]);
  const kept = useMemo(() => new Set(d.keep), [d.keep]);
  const perPage = useMemo(() => {
    const c = new Array<number>(n).fill(0);
    if (n) for (const h of all) if (!kept.has(hitKey(d.text, h))) c[pageOf(st, h.start)]++;
    return c;
  }, [all, kept, d.text, st, n]);
  const marks = useMemo<Mark[]>(() => {
    if (!p) return [];
    const off = st.offsets[cur];
    const end = off + p.text.text.length;
    return all
      .filter((h) => h.start < end && h.end > off)
      .map((h) => ({ key: hitKey(d.text, h), category: h.category, kept: kept.has(hitKey(d.text, h)), low: h.confidence < 0.7, boxes: spanBoxes(p.text, Math.max(h.start, off) - off, Math.min(h.end, end) - off, pad, p.w, p.h) }));
  }, [all, kept, d.text, st, cur, p, pad]);
  const manual = useMemo(() => st.manual.filter((m) => m.page === cur).map((m) => m.box), [st.manual, cur]);
  const selHit = sel ? all.find((h) => hitKey(d.text, h) === sel) : undefined;

  // a finding picked in the list below shows its page
  useEffect(() => {
    if (selHit && n) setPage(pageOf(st, selHit.start));
  }, [selHit?.start]);

  if (st.locked) return <Unlock d={d} ops={ops} />;

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 2000);
  };
  const out = st.out;
  const ready = !!out && !st.rendering && d.status === 'ready' && d.maskedVer === d.mver;
  const allowed = ready && (!needReview || st.reviewed);
  const inv = st.inv;
  const ocrPages = st.pages.filter((x) => x.ocr);
  const dropped = st.pages.reduce((a, x) => ({ links: a.links + x.dropped.links, comments: a.comments + x.dropped.comments, attachments: a.attachments + x.dropped.attachments }), { links: 0, comments: 0, attachments: 0 });
  const qr = st.pages.reduce((k, x) => k + x.qr.length, 0);

  return (
    <>
      {n > 1 && (
        <nav className="pagestrip" aria-label="pages">
          {st.pages.map((_, i) => (
            <button key={i} className={i === cur ? 'chip on' : 'chip'} aria-current={i === cur} onClick={() => setPage(i)} title={`${perPage[i]} finding(s) on page ${i + 1}`}>
              {i + 1}
              {perPage[i] > 0 && <b> · {perPage[i]}</b>}
            </button>
          ))}
        </nav>
      )}
      <div className="cols">
        <section className="panel">
          <div className="panelhead">
            <h2>Original{n > 1 ? `, page ${cur + 1} of ${n}` : ''}</h2>
            <div className="grow" />
            <label className="small">
              drag to cover{' '}
              <select aria-label="type of the box you draw" value={boxType} onChange={(e) => setBoxType(e.target.value)}>
                {BOX_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>
          <div className="imgview">
            {p ? (
              <PageView bmp={orig} w={p.w} h={p.h} marks={marks} manual={manual} sel={sel} onSelect={setSel} onBox={(b) => ops.addBox(d, cur, b, boxType)} label={`page ${cur + 1} with findings; drag to cover an area, click a box for details`} />
            ) : (
              <div className="muted small">{st.progress ?? 'Opening the PDF…'}</div>
            )}
          </div>
          {selHit && (
            <div className="detail">
              <div><span className={'chip cat-' + selHit.category}>{selHit.type}</span> <b>{Math.round(selHit.confidence * 100)}%</b> confidence</div>
              <div className="mono val">{d.text.slice(selHit.start, selHit.end).slice(0, 120)}</div>
              <div>{selHit.reason}</div>
              <div className="row">
                {kept.has(sel!) ? <button onClick={() => onUnkeep(d, selHit)}>Mask this again</button> : <button onClick={() => onKeepOnce(d, selHit)}>Keep (this time)</button>}
              </div>
            </div>
          )}
          {st.manual.length > 0 && (
            <div className="small">
              Areas you covered:{' '}
              {st.manual.map((m, i) => (
                <button key={i} className="chip" onClick={() => ops.removeBox(d, i)} aria-label={`remove covered ${m.type.toLowerCase()} on page ${m.page + 1}`}>
                  p{m.page + 1} {m.type.toLowerCase()} ×
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panelhead">
            <h2>Redacted copy</h2>
            <div className="grow" />
            <span className="small muted" aria-live="polite">{msg}</span>
            <button className="primary" disabled={!allowed} onClick={() => ops.download(d)}>Download PDF</button>
            <button disabled={!d.result || d.status !== 'ready' || d.maskedVer !== d.mver} onClick={async () => flash((await copyText(outputOf(d))) ? 'Copied text' : 'copy failed')}>Copy text</button>
          </div>
          <div className="imgview">
            {outPage ? <CopyView bmp={outBmp} stale={!ready} label={`redacted copy of page ${cur + 1}`} /> : <div className="muted small">{d.status === 'error' ? 'No copy: see the error above.' : st.rendering || st.progress ? st.progress ?? 'Redacting…' : !p ? 'Reading…' : 'Masking…'}</div>}
          </div>
          {needReview && (
            <label className="reviewed">
              <input type="checkbox" checked={st.reviewed} disabled={!ready} onChange={(e) => ops.setReviewed(d, e.target.checked)} /> I checked every page of the redacted copy: nothing sensitive is left (faces, signatures, handwriting, logos are not found automatically)
            </label>
          )}
          {d.result && (
            <details className="maskedtext">
              <summary>Masked text</summary>
              <pre className={d.status === 'ready' && d.maskedVer === d.mver ? 'out' : 'out stale'}>{d.result.output.length > 50_000 ? d.result.output.slice(0, 50_000) + '\n… (Copy text copies all of it)' : d.result.output}</pre>
            </details>
          )}
          <ul className="report small">
            {inv && <li>{inv.pages} page{inv.pages === 1 ? '' : 's'}{n < inv.pages ? `: only the first ${n} were read and are in the copy (page limit in Settings)` : ''}. Read in {((st.readMs ?? 0) / 1000).toFixed(1)} s{ocrPages.length ? `; OCR on ${ocrPages.length === n ? 'every page' : `page${ocrPages.length > 1 ? 's' : ''} ${ocrPages.map((x) => st.pages.indexOf(x) + 1).join(', ')}`} (images or no text layer)` : ''}.</li>}
            <li>The copy has images of the pages only: no text layer, metadata, form fields, comments, links, bookmarks, attachments or scripts. Its text cannot be selected or searched.</li>
            {inv && inv.info.length > 0 && <li>Document properties left out: {inv.info.map(([k, v]) => `${k} “${v.length > 40 ? v.slice(0, 40) + '…' : v}”`).join(', ')}{inv.xmp ? '; XMP metadata' : ''}.</li>}
            {inv && !inv.info.length && inv.xmp && <li>XMP metadata left out.</li>}
            {inv && inv.attachments.length > 0 && <li>Attachments left out: {inv.attachments.join(', ')}.</li>}
            {inv?.scripts && <li>Scripts left out.</li>}
            {inv && inv.fields > 0 && <li>{inv.fields} form field{inv.fields > 1 ? 's' : ''}: their values are in the text and in the page images (covered where they hold findings); the fields themselves are left out.</li>}
            {inv && inv.signatures > 0 && <li className="warntext">{inv.signatures} digital signature field{inv.signatures > 1 ? 's' : ''}: the copy is not signed.</li>}
            {(dropped.comments > 0 || dropped.links > 0 || dropped.attachments > 0) && <li>Left out: {[dropped.comments && `${dropped.comments} comment(s)`, dropped.links && `${dropped.links} link(s)`, dropped.attachments && `${dropped.attachments} attached file(s)`].filter(Boolean).join(', ')}. Their text is in the masked text.</li>}
            {inv && inv.bookmarks > 0 && <li>{inv.bookmarks} bookmark{inv.bookmarks > 1 ? 's' : ''} left out.</li>}
            {inv && inv.hiddenLayers.length > 0 && <li>Hidden layers ({inv.hiddenLayers.join(', ')}) are not in the copy; their text is in the masked text.</li>}
            {inv && inv.revisions > 1 && <li>The file kept {inv.revisions - 1} earlier version{inv.revisions > 2 ? 's' : ''} (incremental saves): only the current one is in the copy.</li>}
            {qr > 0 && <li>{qr} QR code{qr > 1 ? 's' : ''} covered.</li>}
            {out?.verify.ran && out.verify.readable.length === 0 && <li className="oktext">Checked by reading the copy again: no masked value is readable{out.verify.covered ? ` (${out.verify.covered} more places were covered)` : ''}.</li>}
            {out?.verify.ran && out.verify.readable.length > 0 && <li className="warntext">Still readable in the copy: {out.verify.readable.map((v) => v.slice(0, 20)).join(', ')}. Cover them by hand.</li>}
            {out && <li>Copy made in {(out.ms / 1000).toFixed(1)} s, {(out.bytes.length / 1024 / 1024).toFixed(1)} MB.</li>}
          </ul>
        </section>
      </div>
    </>
  );
}
