import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { opt, type Hit, type Settings } from '../engine/light';
import { spanBoxes } from '../media/ocrdoc';
import type { Box } from '../media/ocrTypes';
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

const COLORS: Record<string, string> = { secret: '#dc2626', personal: '#2563eb', financial: '#9333ea', network: '#059669', custom: '#d97706' };
const BOX_TYPES: [string, string][] = [
  ['AREA', 'area'],
  ['FACE', 'face'],
  ['SIGNATURE', 'signature'],
];

/** Decoded image for a canvas; the previous bitmap is released when the bytes change. */
function useBitmap(bytes?: Uint8Array): ImageBitmap | null {
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    if (!bytes) {
      setBmp(null);
      return;
    }
    let alive = true;
    let made: ImageBitmap | null = null;
    const blob = new Blob([bytes as BlobPart]);
    createImageBitmap(blob, { imageOrientation: 'from-image' })
      .catch(() => createImageBitmap(blob))
      .then((b) => {
        if (alive) setBmp((made = b));
        else b.close();
      })
      .catch(() => setBmp(null));
    return () => {
      alive = false;
      made?.close();
    };
  }, [bytes]);
  return bmp;
}

const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
const inside = (b: Box, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

export function ImageReview({ d, settings, sel, setSel, ops, onKeepOnce, onUnkeep }: Props) {
  const img = d.image!;
  const orig = useBitmap(img.bytes);
  const outBmp = useBitmap(img.out?.bytes);
  const canvas = useRef<HTMLCanvasElement>(null);
  const outCanvas = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const [boxType, setBoxType] = useState('AREA');
  const [fixText, setFixText] = useState('');
  const [msg, setMsg] = useState('');
  const pad = Number(opt(settings, 'imgPad', '0.2')) || 0.2;
  const needReview = opt(settings, 'imgReview', true);
  const W = img.width || orig?.width || 0;
  const H = img.height || orig?.height || 0;
  const all = useMemo(() => [...d.hits, ...d.extra].sort((a, b) => a.start - b.start), [d.hits, d.extra]);
  const kept = useMemo(() => new Set(d.keep), [d.keep]);
  const boxes = useMemo(() => all.map((h) => ({ h, key: hitKey(d.text, h), boxes: img.text ? spanBoxes(img.text, h.start, h.end, pad, W, H) : [] })), [all, d.text, img.text, pad, W, H]);
  const selHit = sel ? all.find((h) => hitKey(d.text, h) === sel) : undefined;
  useEffect(() => setFixText(selHit ? d.text.slice(selHit.start, selHit.end) : ''), [selHit, d.text]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !orig) return;
    c.width = orig.width;
    c.height = orig.height;
    const x = c.getContext('2d')!;
    try {
      x.drawImage(orig, 0, 0);
    } catch {
      return; // released while a new image is being decoded
    }
    const lw = Math.max(2, Math.round(Math.max(orig.width, orig.height) / 700));
    for (const { h, key, boxes: bs } of boxes) {
      const color = COLORS[h.category] ?? COLORS.custom;
      const isKept = kept.has(key);
      for (const b of bs) {
        if (!isKept) {
          x.fillStyle = color + '40';
          x.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        }
        x.setLineDash(isKept ? [lw * 3, lw * 2] : h.confidence < 0.7 ? [lw, lw] : []);
        x.lineWidth = key === sel ? lw * 3 : lw;
        x.strokeStyle = color;
        x.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      }
    }
    x.setLineDash([]);
    for (const m of img.manual) {
      x.fillStyle = 'rgba(0,0,0,0.6)';
      x.fillRect(m.box[0], m.box[1], m.box[2] - m.box[0], m.box[3] - m.box[1]);
    }
    if (drag) {
      x.setLineDash([lw * 2, lw * 2]);
      x.lineWidth = lw;
      x.strokeStyle = '#111';
      x.strokeRect(drag[0], drag[1], drag[2] - drag[0], drag[3] - drag[1]);
      x.setLineDash([]);
    }
  }, [orig, boxes, kept, sel, img.manual, drag]);

  useEffect(() => {
    const c = outCanvas.current;
    if (!c || !outBmp) return;
    c.width = outBmp.width;
    c.height = outBmp.height;
    try {
      c.getContext('2d')!.drawImage(outBmp, 0, 0);
    } catch {
      /* released while the next copy is being decoded */
    }
  }, [outBmp]);

  const toImage = (e: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height];
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = toImage(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag([x, y, x, y]);
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const [x, y] = toImage(e);
    setDrag([drag[0], drag[1], x, y]);
  };
  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const [x, y] = toImage(e);
    setDrag(null);
    const b: Box = [Math.min(drag[0], x), Math.min(drag[1], y), Math.max(drag[0], x), Math.max(drag[1], y)];
    const min = Math.max(6, W / 150);
    if (b[2] - b[0] > min && b[3] - b[1] > min) {
      ops.addBox(d, [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])], boxType);
      return;
    }
    // a click: the smallest finding under the pointer
    const under = boxes.filter((x2) => x2.boxes.some((bb) => inside(bb, x, y))).sort((a, b2) => area(a.boxes[0]) - area(b2.boxes[0]));
    setSel(under[0] ? (under[0].key === sel ? null : under[0].key) : null);
  };

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
            {orig ? <canvas ref={canvas} className="imgcanvas" aria-label="image with findings; drag to cover an area, click a box for details" onPointerDown={down} onPointerMove={move} onPointerUp={up} /> : <div className="muted small">Decoding…</div>}
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
            {out ? <canvas ref={outCanvas} className={ready ? 'imgcanvas' : 'imgcanvas stale'} aria-label="redacted copy" /> : <div className="muted small">{d.status === 'error' ? 'No copy: see the error above.' : img.rendering ? 'Painting the redactions…' : !read ? 'Reading the text in the image…' : 'Masking…'}</div>}
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
