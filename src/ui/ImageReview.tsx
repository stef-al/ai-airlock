import { useEffect, useMemo, useState } from 'react';
import { opt, type Hit, type Settings } from '../engine/light';
import { spanBoxes } from '../media/ocrdoc';
import type { Box } from '../media/ocrTypes';
import { BOX_TYPES, CopyView, PageView, useBitmap, type Mark } from './PageView';
import { hitKey, type DocState } from './types';
import { copyText } from './util';

export interface ImageOps {
  addBox(d: DocState, box: Box, type: string): void;
  removeBox(d: DocState, index: number): void;
  /** the OCR misread a finding: replace its text */
  fix(d: DocState, h: Hit, text: string): void;
  setReviewed(d: DocState, v: boolean): void;
  copyImage(d: DocState): Promise<boolean>;
  download(d: DocState): void;
}

interface Props {
  d: DocState;
  settings: Settings;
  sel: string | null;
  setSel(k: string | null): void;
  ops: ImageOps;
  onKeepOnce(d: DocState, h: Hit): void;
  onUnkeep(d: DocState, h: Hit): void;
}

export function ImageReview({ d, settings, sel, setSel, ops, onKeepOnce, onUnkeep }: Props) {
  const img = d.image!;
  const orig = useBitmap(img.bytes);
  const outBmp = useBitmap(img.out?.bytes);
  const [boxType, setBoxType] = useState('AREA');
  const [fixText, setFixText] = useState('');
  const [msg, setMsg] = useState('');
  const pad = Number(opt(settings, 'imgPad', '0.2')) || 0.2;
  const needReview = opt(settings, 'imgReview', true);
  const W = img.width || orig?.width || 0;
  const H = img.height || orig?.height || 0;
  const all = useMemo(() => [...d.hits, ...d.extra].sort((a, b) => a.start - b.start), [d.hits, d.extra]);
  const kept = useMemo(() => new Set(d.keep), [d.keep]);
  const marks = useMemo<Mark[]>(
    () => all.map((h) => ({ key: hitKey(d.text, h), category: h.category, kept: kept.has(hitKey(d.text, h)), low: h.confidence < 0.7, boxes: img.text ? spanBoxes(img.text, h.start, h.end, pad, W, H) : [] })),
    [all, d.text, img.text, pad, W, H, kept],
  );
  const manual = useMemo(() => img.manual.map((m) => m.box), [img.manual]);
  const selHit = sel ? all.find((h) => hitKey(d.text, h) === sel) : undefined;
  useEffect(() => setFixText(selHit ? d.text.slice(selHit.start, selHit.end) : ''), [selHit, d.text]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 2000);
  };
  const out = img.out;
  const ready = !!out && !img.rendering && d.status === 'ready' && d.maskedVer === d.mver;
  const allowed = ready && (!needReview || img.reviewed);
  const read = img.read;
  const qr = img.regions.length;

  return (
    <>
      <div className="cols">
        <section className="panel">
          <div className="panelhead">
            <h2>Original</h2>
            <div className="grow" />
            <label className="small">
              drag to cover{' '}
              <select aria-label="type of the box you draw" value={boxType} onChange={(e) => setBoxType(e.target.value)}>
                {BOX_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>
          <div className="imgview">
            <PageView bmp={orig} w={W} h={H} marks={marks} manual={manual} sel={sel} onSelect={setSel} onBox={(b) => ops.addBox(d, b, boxType)} label="image with findings; drag to cover an area, click a box for details" />
          </div>
          {selHit && (
            <div className="detail">
              <div><span className={'chip cat-' + selHit.category}>{selHit.type}</span> <b>{Math.round(selHit.confidence * 100)}%</b> confidence</div>
              <div>{selHit.reason}</div>
              {selHit.user !== 'region' && (
                <div className="row">
                  <label>
                    read as <input className="mono" aria-label="text of this finding as the image shows it" value={fixText} onChange={(e) => setFixText(e.target.value)} />
                  </label>
                  <button disabled={!fixText || fixText === d.text.slice(selHit.start, selHit.end)} onClick={() => ops.fix(d, selHit, fixText)}>Correct</button>
                </div>
              )}
              <div className="small muted">OCR can misread characters (1 for !, 0 for O). Correct them here: the corrected value is what a restore puts back.</div>
              <div className="row">
                {kept.has(sel!) ? <button onClick={() => onUnkeep(d, selHit)}>Mask this again</button> : <button onClick={() => onKeepOnce(d, selHit)}>Keep (this time)</button>}
              </div>
            </div>
          )}
          {img.manual.length > 0 && (
            <div className="small">
              Areas you covered:{' '}
              {img.manual.map((m, i) => (
                <button key={i} className="chip" onClick={() => ops.removeBox(d, i)} aria-label={`remove covered ${m.type.toLowerCase()} ${i + 1}`}>
                  {m.type.toLowerCase()} {i + 1} ×
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
            <button className="primary" disabled={!allowed} onClick={async () => flash((await ops.copyImage(d)) ? 'Copied image' : 'Copy failed: use Download')}>Copy image</button>
            <button disabled={!allowed} onClick={() => ops.download(d)}>Download</button>
            <button disabled={!ready || !d.result} onClick={async () => flash((await copyText(d.result!.output)) ? 'Copied text' : 'copy failed')}>Copy text</button>
          </div>
          <div className="imgview">
            {out ? <CopyView bmp={outBmp} stale={!ready} label="redacted copy" /> : <div className="muted small">{d.status === 'error' ? 'No copy: see the error above.' : img.rendering ? 'Painting the redactions…' : !read ? 'Reading the text in the image…' : 'Masking…'}</div>}
          </div>
          {needReview && (
            <label className="reviewed">
              <input type="checkbox" checked={img.reviewed} disabled={!ready} onChange={(e) => ops.setReviewed(d, e.target.checked)} /> I checked the redacted copy: nothing sensitive is left (faces, signatures, handwriting, logos are not found automatically)
            </label>
          )}
          <ul className="report small">
            {read && <li>Text read in {read.ms} ms{read.scale > 1 ? `, enlarged ×${read.scale}` : ''}{read.inverted ? ', dark background inverted' : ''}; OCR confidence {Math.round(read.ocr.conf)}%.</li>}
            <li>{img.meta.found.length ? `Removed with the re-encoding: ${img.meta.found.join(', ')}.` : 'No metadata found; the copy is a newly encoded image anyway.'}</li>
            {img.meta.frames > 1 && <li>Animated image: only the first of {img.meta.frames} frames is kept.</li>}
            {qr > 0 && <li>{qr} QR code{qr > 1 ? 's' : ''} covered: {img.regions.map((g) => g.text.slice(0, 60)).join(' | ')}</li>}
            {out?.verify.ran && out.verify.readable.length === 0 && <li className="oktext">Checked by reading the copy again: no masked value is readable{out.verify.covered ? ` (${out.verify.covered} more places were covered)` : ''}.</li>}
            {out?.verify.ran && out.verify.readable.length > 0 && <li className="warntext">Still readable in the copy: {out.verify.readable.map((v) => v.slice(0, 20)).join(', ')}. Cover them by hand.</li>}
          </ul>
        </section>
      </div>
    </>
  );
}
