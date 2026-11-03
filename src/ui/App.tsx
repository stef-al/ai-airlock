import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUILTIN_PROFILES, defaultSettings, mergeSettings, regionFromLocale, type Hit, type MappingSnapshot, type Profile, type Settings } from '../engine/light';
import type { Box } from '../media/ocrTypes';
import type { AnalyzeRes, MaskRes } from '../worker/protocol';
import { CancelledError, engine } from './engineClient';
import type { ImageOps } from './ImageReview';
import type { OfficeOps } from './OfficeReview';
import type { PdfOps } from './PdfReview';
import { MaskView } from './MaskView';
import { loadMedia, MEDIA } from './media';
import { RestoreView } from './RestoreView';
import { SettingsView } from './SettingsView';
import { loadActive, loadProfiles, loadSettings, saveActive, saveProfiles, saveSettings } from './store';
import { hitKey, selectedHits, type DocState } from './types';
import { copyImage, downloadBytes, fromBase64, readInput, toBase64 } from './util';

type Tab = 'mask' | 'restore' | 'settings' | 'about';
let nextId = 1;
const newDoc = (name = 'pasted text', text = ''): DocState => ({
  id: 'd' + nextId++, name, kind: 'text', text, ver: 1, editing: true, status: 'idle', hits: [], keep: [], extra: [], mver: 0, maskedVer: -1,
});
const EMPTY_MAPPING: MappingSnapshot = { entries: [], counters: [], reservedIds: [], reservedFakes: [] };
const DATA_PREFIX = /data:image\/[\w+.-]+(?:;[\w=.-]+)*;base64,$/;

export function App() {
  const [tab, setTab] = useState<Tab>('mask');
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [profiles, setProfiles] = useState<Profile[]>(loadProfiles);
  const [activeProfile, setActiveProfile] = useState<string>(loadActive);
  const [docs, setDocs] = useState<DocState[]>(() => [newDoc()]);
  const [activeId, setActiveId] = useState<string>(() => 'd' + (nextId - 1));
  const [busy, setBusy] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
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
  const rendering = useRef(new Set<string>());

  useEffect(() => engine.subscribe(setBusy), []);
  useEffect(() => {
    if (!MEDIA) return;
    let off: (() => void) | undefined;
    void loadMedia().then((m) => (off = m.media.subscribe(setMediaBusy)));
    return () => off?.();
  }, []);

  const patch = useCallback((id: string, p: Partial<DocState>) => updateDocs((ds) => ds.map((d) => (d.id === id ? { ...d, ...p } : d))), [updateDocs]);

  const runAnalyze = useCallback(
    async (id: string) => {
      const d = docsRef.current.find((x) => x.id === id);
      if (!d) return;
      if (!d.text.trim() && d.kind === 'text') {
        patch(id, { status: 'idle', hits: [], result: undefined, keep: [], mver: d.mver + 1, maskedVer: d.mver + 1 });
        return;
      }
      patch(id, { status: 'analyzing', error: undefined });
      const ver = d.ver;
      try {
        const image = d.kind === 'image';
        const office = d.office?.file ? (await loadMedia()).officeAnalyzeOptions(d.office.file.kind) : null;
        const res = await engine.call<AnalyzeRes>({
          type: 'analyze', docKey: id, text: d.text, settings: settingsRef.current,
          ...(image || d.pdf?.usedOcr ? { ocr: true } : d.kind === 'pdf' ? {} : office ?? { fileName: d.name === 'pasted text' ? undefined : d.name }),
        });
        const cur = docsRef.current.find((x) => x.id === id);
        if (!cur || cur.ver !== ver) return;
        const valid = new Set(res.hits.map((h) => hitKey(cur.text, h)));
        patch(id, { hits: res.hits, format: res.format, lang: res.lang, ms: res.ms, status: 'ready', keep: cur.keep.filter((k) => valid.has(k)), mver: cur.mver + 1 });
        if (MEDIA && cur.kind === 'text') syncEmbedded(id, res.hits);
      } catch (e) {
        if (e instanceof CancelledError) patch(id, { status: 'idle', error: e.message });
        else patch(id, { status: 'error', error: (e as Error).message });
      }
    },
    [patch],
  );

  const patchPdf = useCallback(
    (id: string, p: Partial<NonNullable<DocState['pdf']>>) => updateDocs((ds) => ds.map((x) => (x.id === id && x.pdf ? { ...x, pdf: { ...x.pdf, ...p } } : x))),
    [updateDocs],
  );

  /** A PDF's pages: text layer, OCR where needed, annotations; the text then goes through the usual analysis. */
  const runReadPdf = useCallback(
    async (id: string) => {
      const d = docsRef.current.find((x) => x.id === id);
      if (!d?.pdf) return;
      patch(id, { status: 'analyzing', error: undefined, result: undefined, pdf: { ...d.pdf, out: undefined, locked: undefined, progress: 'Opening the PDF…' } });
      const m = await loadMedia();
      try {
        const r = await m.readPdf(d.pdf, settingsRef.current, (msg) => patchPdf(id, { progress: msg }));
        updateDocs((ds) =>
          ds.map((x) =>
            x.id === id && x.pdf
              ? { ...x, pdf: { ...x.pdf, inv: r.inv, pages: r.pages, offsets: r.offsets, usedOcr: r.usedOcr, readKey: r.readKey, readMs: r.readMs, out: undefined, progress: undefined, reviewed: false }, text: r.text, ver: x.ver + 1, keep: [], extra: r.extra }
              : x,
          ),
        );
        scheduleAnalyzeRef.current(id, 0);
      } catch (e) {
        if (e instanceof m.PdfPasswordError) {
          patchPdf(id, { locked: e.wrong ? 'wrong' : 'need', progress: undefined });
          patch(id, { status: 'idle' });
        } else if (e instanceof CancelledError) {
          patchPdf(id, { progress: undefined });
          patch(id, { status: 'idle', error: e.message });
        } else {
          patchPdf(id, { progress: undefined });
          patch(id, { status: 'error', error: 'Reading the PDF failed: ' + (e as Error).message });
        }
      }
    },
    [patch, patchPdf, updateDocs],
  );

  /**
   * An Office file: scrubbed and read (text with its place in the XML); its pictures become image
   * documents of their own whose redacted copies go into the copy of the file.
   */
  const runReadOffice = useCallback(
    async (id: string) => {
      const d = docsRef.current.find((x) => x.id === id);
      if (!d?.office) return;
      patch(id, { status: 'analyzing', error: undefined, result: undefined });
      try {
        const m = await loadMedia();
        const r = await m.readOffice(d.office.bytes);
        const children: DocState[] = r.pictures.map((pic) => ({ ...newDoc(`${d.name} › ${pic.name}`), kind: 'image', editing: false, status: 'analyzing', image: m.newImageState(pic.bytes), parent: { id, key: pic.path } }));
        updateDocs((ds) => [
          ...ds.filter((c) => c.parent?.id !== id).map((x) => (x.id === id && x.office ? { ...x, office: { ...x.office, ...r }, text: r.file.text.text, ver: x.ver + 1, keep: [], extra: [] } : x)),
          ...children,
        ]);
        children.forEach((c) => void runReadRef.current(c.id));
        scheduleAnalyzeRef.current(id, 0);
      } catch (e) {
        patch(id, { status: 'error', error: 'Reading the file failed: ' + (e as Error).message });
      }
    },
    [patch, updateDocs],
  );
  const runReadRef = useRef<(id: string) => Promise<void>>(async () => {});

  /** OCR of an image document; its text then goes through the usual analysis. */
  const runRead = useCallback(
    async (id: string) => {
      const d = docsRef.current.find((x) => x.id === id);
      if (d?.pdf) return runReadPdf(id);
      if (d?.office) return runReadOffice(id);
      if (!d?.image) return;
      patch(id, { status: 'analyzing', error: undefined, result: undefined, image: { ...d.image, out: undefined } });
      try {
        const m = await loadMedia();
        const r = await m.readImageText(d.image, settingsRef.current);
        const readKey = m.readKey(settingsRef.current);
        updateDocs((ds) => ds.map((x) => (x.id === id && x.image ? { ...x, image: { ...x.image, ...r, readKey, out: undefined }, text: r.text.text, ver: x.ver + 1, keep: [], extra: m.regionHits(r.text, r.regions) } : x)));
        scheduleAnalyzeRef.current(id, 0);
      } catch (e) {
        if (e instanceof CancelledError) patch(id, { status: 'idle', error: e.message });
        else patch(id, { status: 'error', error: 'Reading the image failed: ' + (e as Error).message });
      }
    },
    [patch, updateDocs, runReadPdf, runReadOffice],
  );
  runReadRef.current = runRead;
  const scheduleAnalyzeRef = useRef<(id: string, delay?: number) => void>(() => {});

  /**
   * Images embedded in a text document (data: URIs) become image documents of their own. Once
   * redacted and reviewed, their copy replaces the IMAGE_n placeholder when the text is copied.
   */
  const syncEmbedded = useCallback(
    (id: string, hits: Hit[]) => {
      const d = docsRef.current.find((x) => x.id === id);
      if (!d) return;
      const keys = new Map(hits.filter((h) => h.type === 'IMAGE').map((h) => [hitKey(d.text, h), h]));
      const children = docsRef.current.filter((c) => c.parent?.id === id);
      const have = new Set(children.map((c) => c.parent!.key));
      const fresh: DocState[] = [];
      void loadMedia().then((m) => {
        let n = children.length;
        for (const [key, h] of keys) {
          if (have.has(key)) continue;
          const bytes = fromBase64(d.text.slice(h.start, h.end));
          if (!m.isImage(bytes)) continue;
          const c = newDoc(`${d.name} › image ${++n}`);
          fresh.push({ ...c, kind: 'image', editing: false, status: 'analyzing', image: m.newImageState(bytes), parent: { id, key } });
        }
        updateDocs((ds) => [...ds.filter((c) => !(c.parent?.id === id && !keys.has(c.parent.key))), ...fresh]);
        fresh.forEach((c) => void runRead(c.id));
      });
    },
    [updateDocs, runRead],
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
  scheduleAnalyzeRef.current = scheduleAnalyze;

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
            // an image is masked as plain text: boxes are painted, so there is no structure to guard
            format: d.kind !== 'text' ? 'prose' : (d.format ?? 'prose'), lang: d.lang, hits, mapping: mappingRef.current ?? EMPTY_MAPPING,
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

  // images: paint the masked findings into a new file (and check the result) after each masking
  useEffect(() => {
    if (!MEDIA) return;
    for (const d of docs) {
      const img = d.image;
      if (d.kind !== 'image' || !img || !d.result || d.status !== 'ready' || d.maskedVer !== d.mver || rendering.current.has(d.id)) continue;
      const opts = JSON.stringify([settings.options.imgLabels, settings.options.imgPad, settings.options.imgAllText, settings.options.imgVerify]);
      const key = `${d.maskedVer}:${img.rver}:${opts}`;
      if (img.out?.key === key) continue;
      rendering.current.add(d.id);
      const res = d.result;
      updateDocs((ds) => ds.map((x) => (x.id === d.id && x.image ? { ...x, image: { ...x.image, rendering: true } } : x)));
      loadMedia()
        .then((m) => m.redact(img, res, settingsRef.current, key))
        // a new copy has to be checked again
        .then((out) => updateDocs((ds) => ds.map((x) => (x.id === d.id && x.image && x.maskedVer === d.maskedVer && x.image.rver === img.rver ? { ...x, image: { ...x.image, out, rendering: false, reviewed: false } } : x))))
        .catch((e: Error) => {
          if (!(e instanceof CancelledError)) updateDocs((ds) => ds.map((x) => (x.id === d.id ? { ...x, status: 'error', error: 'Redacting the image failed: ' + e.message } : x)));
        })
        .finally(() => {
          rendering.current.delete(d.id);
          updateDocs((ds) => ds.map((x) => (x.id === d.id && x.image?.rendering ? { ...x, image: { ...x.image, rendering: false } } : x)));
        });
    }
  }, [docs, settings, updateDocs]);

  // PDFs: render every page with the masked findings painted over, check it, write the copy
  useEffect(() => {
    if (!MEDIA) return;
    for (const d of docs) {
      const pdf = d.pdf;
      if (d.kind !== 'pdf' || !pdf || !d.result || d.status !== 'ready' || d.maskedVer !== d.mver || rendering.current.has(d.id)) continue;
      const opts = JSON.stringify([settings.options.imgLabels, settings.options.imgPad, settings.options.imgAllText, settings.options.imgVerify, settings.options.pdfDpi]);
      const key = `${d.maskedVer}:${pdf.rver}:${opts}`;
      if (pdf.out?.key === key) continue;
      rendering.current.add(d.id);
      const res = d.result;
      patchPdf(d.id, { rendering: true });
      loadMedia()
        .then((m) => m.redactPdf(pdf, res, settingsRef.current, key, (msg) => patchPdf(d.id, { progress: msg })))
        .then((out) => updateDocs((ds) => ds.map((x) => (x.id === d.id && x.pdf && x.maskedVer === d.maskedVer && x.pdf.rver === pdf.rver ? { ...x, pdf: { ...x.pdf, out, reviewed: false } } : x))))
        .catch((e: Error) => {
          if (!(e instanceof CancelledError)) updateDocs((ds) => ds.map((x) => (x.id === d.id ? { ...x, status: 'error', error: 'Redacting the PDF failed: ' + e.message } : x)));
        })
        .finally(() => {
          rendering.current.delete(d.id);
          patchPdf(d.id, { rendering: false, progress: undefined });
        });
    }
  }, [docs, settings, updateDocs, patchPdf]);

  // settings: persist, then re-analyse everything
  const firstSettings = useRef(true);
  useEffect(() => {
    saveSettings(settings);
    if (firstSettings.current) {
      firstSettings.current = false;
      return;
    }
    const t = setTimeout(async () => {
      // images are read again when the OCR languages or QR codes changed
      const m = MEDIA ? await loadMedia() : null;
      const readKey = m ? m.readKey(settings) : '';
      const pdfKey = m ? m.pdfReadKey(settings) : '';
      for (const d of docsRef.current) {
        if (d.pdf?.locked) continue;
        if ((d.image && d.image.readKey !== readKey) || (d.pdf && d.pdf.readKey !== pdfKey)) void runRead(d.id);
        else if (d.text.trim() || d.image || d.pdf || d.office) scheduleAnalyze(d.id, 0);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [settings, scheduleAnalyze, runRead]);

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
      const r = await readInput(f, MEDIA);
      if (!r.ok) {
        skipped.push(`${f.name}: ${r.reason}`);
        continue;
      }
      const d = newDoc(f.name, r.kind === 'text' ? r.text : '');
      d.editing = false;
      d.status = 'analyzing';
      if (r.kind === 'image') {
        d.kind = 'image';
        d.image = (await loadMedia()).newImageState(r.bytes);
      } else if (r.kind === 'pdf') {
        d.kind = 'pdf';
        d.pdf = (await loadMedia()).newPdfState(r.bytes);
      } else if (r.kind === 'office') {
        d.kind = 'office';
        d.office = (await loadMedia()).newOfficeState(r.bytes);
      }
      added.push(d);
    }
    if (skipped.length) setNotice('Skipped ' + skipped.join('; '));
    if (!added.length) return;
    updateDocs((ds) => {
      const base = ds.length === 1 && ds[0].kind === 'text' && !ds[0].text.trim() ? [] : ds;
      return [...base, ...added];
    });
    setActiveId(added[0].id);
    added.forEach((d) => (d.image || d.pdf || d.office ? void runRead(d.id) : scheduleAnalyze(d.id, 0)));
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // screenshots pasted with Ctrl+V become image documents
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length || tabRef.current !== 'mask') return;
      e.preventDefault();
      void addFilesRef.current(files.map((f, i) => new File([f], `pasted image ${i + 1}.${f.type.split('/')[1] ?? 'png'}`, { type: f.type })));
    };
    document.addEventListener('paste', h);
    return () => document.removeEventListener('paste', h);
  }, []);

  /** The masked text to copy: embedded images are swapped for their redacted copy once reviewed. */
  const outputOf = (d: DocState): string => {
    const res = d.result;
    if (!res) return '';
    if (!MEDIA || !res.replacements.some((r) => r.hit.type === 'IMAGE')) return res.output;
    let out = '';
    let pos = 0;
    for (const r of res.replacements) {
      if (r.hit.type !== 'IMAGE') continue;
      const child = docsRef.current.find((c) => c.parent?.id === d.id && c.parent.key === hitKey(d.text, r.hit));
      const img = child?.image;
      const review = settingsRef.current.options.imgReview !== false;
      if (!img?.out || (review && !img.reviewed)) continue;
      let before = res.output.slice(pos, r.outStart);
      // the redacted copy may be a PNG where the original was another format
      before = before.replace(DATA_PREFIX, `data:${img.out.mime};base64,`);
      out += before + toBase64(img.out.bytes);
      pos = r.outEnd;
    }
    return out + res.output.slice(pos);
  };

  const imageOps: ImageOps = {
    addBox: (d, box: Box, type: string) => d.image && patch(d.id, { image: { ...d.image, manual: [...d.image.manual, { box, type }], rver: d.image.rver + 1, reviewed: false } }),
    removeBox: (d, i) => d.image && patch(d.id, { image: { ...d.image, manual: d.image.manual.filter((_, j) => j !== i), rver: d.image.rver + 1, reviewed: false } }),
    fix: (d, h, text) => {
      if (!d.image?.text) return;
      void loadMedia().then((m) => {
        const t = m.applyFixes(d.image!.text!, [{ start: h.start, end: h.end, text }]);
        updateDocs((ds) => ds.map((x) => (x.id === d.id && x.image ? { ...x, image: { ...x.image, text: t, reviewed: false }, text: t.text, ver: x.ver + 1, keep: [], extra: m.regionHits(t, x.image.regions) } : x)));
        scheduleAnalyze(d.id, 0);
      });
    },
    setReviewed: (d, v) => d.image && patch(d.id, { image: { ...d.image, reviewed: v } }),
    copyImage: async (d) => {
      const out = d.image?.out;
      if (!out) return false;
      if (out.mime === 'image/png') return copyImage(out.bytes);
      const m = await loadMedia();
      const png = await m.renderRedacted(d.image!.bytes, out.boxes, 'image/png', m.imageOptions(settingsRef.current).labels);
      return copyImage(png.bytes);
    },
    download: (d) => {
      const out = d.image?.out;
      if (!out) return;
      const base = d.name.replace(/\.[^./]+$/, '').replace(/[^\w.-]+/g, '-') || 'image';
      downloadBytes(`${base}-redacted.${out.mime === 'image/jpeg' ? 'jpg' : 'png'}`, out.bytes, out.mime);
    },
  };

  const pdfOps: PdfOps = {
    addBox: (d, page, box: Box, type: string) => d.pdf && patch(d.id, { pdf: { ...d.pdf, manual: [...d.pdf.manual, { page, box, type }], rver: d.pdf.rver + 1, reviewed: false } }),
    removeBox: (d, i) => d.pdf && patch(d.id, { pdf: { ...d.pdf, manual: d.pdf.manual.filter((_, j) => j !== i), rver: d.pdf.rver + 1, reviewed: false } }),
    setReviewed: (d, v) => d.pdf && patch(d.id, { pdf: { ...d.pdf, reviewed: v } }),
    download: (d) => {
      const out = d.pdf?.out;
      if (!out) return;
      const base = d.name.replace(/\.[^./]+$/, '').replace(/[^\w.-]+/g, '-') || 'document';
      downloadBytes(`${base}-redacted.pdf`, out.bytes, 'application/pdf');
    },
    unlock: (d, password) => {
      if (!d.pdf) return;
      patch(d.id, { pdf: { ...d.pdf, password, locked: undefined } });
      void runRead(d.id);
    },
  };

  /** pictures of an Office file: their child documents, and whether each one is ready for the copy */
  const officePictures = (d: DocState) =>
    (d.office?.pictures ?? []).map((pic) => {
      const child = docsRef.current.find((c) => c.parent?.id === d.id && c.parent.key === pic.path);
      const img = child?.image;
      const fresh = !!child && !!img?.out && !img.rendering && child.status === 'ready' && child.maskedVer === child.mver;
      return { pic, child, ready: fresh && (settingsRef.current.options.imgReview === false || !!img?.reviewed) };
    });
  const officeOps: OfficeOps = {
    pictures: officePictures,
    open: (id) => setActiveId(id),
    download: async (d) => {
      const res = d.result;
      if (!d.office || !res) return;
      const pics = officePictures(d);
      if (pics.some((p) => !p.ready)) return setNotice('Every picture of the file has to be redacted (and reviewed) first.');
      try {
        const m = await loadMedia();
        const images = new Map(pics.map(({ pic, child }) => [pic.path, { bytes: child!.image!.out!.bytes, mime: child!.image!.out!.mime, width: child!.image!.width, height: child!.image!.height }]));
        const bytes = m.officeCopy(d.office, res, images);
        const kind = d.office.file?.kind ?? 'docx';
        const ext = /\.(\w+)$/.exec(d.name)?.[1] ?? kind;
        const base = d.name.replace(/\.[^./]+$/, '').replace(/[^\w.-]+/g, '-') || 'document';
        downloadBytes(`${base}-redacted.${ext}`, bytes, m.OFFICE_MIME[kind]);
      } catch (e) {
        setNotice('The copy could not be made: ' + (e as Error).message);
      }
    },
  };

  const stopMedia = (why: string) =>
    MEDIA &&
    void loadMedia().then((m) => {
      m.cancelPdf();
      m.media.cancel(why);
    });
  const closePdfs = (ds: DocState[]) => MEDIA && ds.some((d) => d.pdf) && void loadMedia().then((m) => ds.forEach((d) => d.pdf && void m.closePdf(d.pdf.bytes)));

  const forget = () => {
    engine.cancel('forgotten');
    stopMedia('forgotten');
    closePdfs(docsRef.current);
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
          busy={busy || mediaBusy}
          imageOps={imageOps}
          pdfOps={pdfOps}
          officeOps={officeOps}
          outputOf={outputOf}
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
            closePdfs(docsRef.current.filter((d) => d.id === id));
            updateDocs((ds) => {
              // the pictures of a file go with it
              const rest = ds.filter((d) => d.id !== id && d.parent?.id !== id);
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
          onRetry={(id) => {
            const d = docsRef.current.find((x) => x.id === id);
            // a file whose reading did not finish is read again
            if ((d?.pdf && !d.pdf.readKey) || (d?.image && !d.image.text)) void runRead(id);
            else scheduleAnalyze(id, 0);
          }}
          onCancel={() => {
            engine.cancel('Stopped.');
            stopMedia('Stopped.');
            // stopped copies are not started again until the user asks
            updateDocs((ds) => ds.map((d) => (d.status === 'analyzing' || d.pdf?.rendering || d.image?.rendering ? { ...d, status: 'idle', error: 'Stopped. Edit the text or press Detect to try again.' } : d)));
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
        {MEDIA && <li><b>Pictures and documents</b>: screenshots, photos, PDF, Word, PowerPoint and Excel files get a redacted copy as well: findings, QR codes and faces covered by labelled boxes, metadata removed. Check the copy, then download it or copy the masked text.</li>}
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
        <li>Names and organisations without cues and postal addresses are not covered yet. {MEDIA ? 'OCR can misread characters, faces are found but not always, and signatures, handwriting and logos are not found: review every copy.' : 'Images, PDF and Office files need airlock-media.html.'}</li>
        <li>Chatbots may rewrite or drop placeholders; the restore report lists what did not come back.</li>
      </ul>
    </section>
  );
}
