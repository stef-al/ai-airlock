/// <reference lib="webworker" />
import { analyze, buildDoc, compileUserRegex, Mapping, mask, restoreText, type Doc } from '../engine';
import { skipEmpty } from '../engine/util';
import type { Reply, ReqWithId } from './protocol';

// Keeps the last few analysed documents so toggling a finding only re-runs masking.
const docs = new Map<string, Doc>();

function docFor(key: string, text: string, fileName: string | undefined, format: Doc['format'], lang?: Doc['lang']): Doc {
  const have = docs.get(key);
  if (have && have.text === text) return have;
  const d = buildDoc(text, { format, lang, fileName });
  docs.set(key, d);
  if (docs.size > 6) docs.delete(docs.keys().next().value as string);
  return d;
}

self.onmessage = (e: MessageEvent<ReqWithId>) => {
  const { id, req } = e.data;
  const reply = (m: Reply) => (self as unknown as Worker).postMessage({ id, ...m });
  try {
    switch (req.type) {
      case 'analyze': {
        const a = analyze(req.text, req.settings, { fileName: req.fileName });
        docs.set(req.docKey, a.doc);
        if (docs.size > 6) docs.delete(docs.keys().next().value as string);
        reply({ ok: true, result: { hits: a.hits, format: a.doc.format, lang: a.doc.lang, ms: a.ms } });
        break;
      }
      case 'mask': {
        const doc = docFor(req.docKey, req.text, req.fileName, req.format, req.lang);
        const mapping = Mapping.from(req.mapping);
        const m = mask(doc, req.hits, mapping, req.settings);
        reply({ ok: true, result: { ...m, mapping: mapping.snapshot() } });
        break;
      }
      case 'regex': {
        const re = compileUserRegex(req.pattern, req.flags);
        if (typeof re === 'string') {
          reply({ ok: true, result: { error: re, matches: [] } });
          break;
        }
        const matches: [number, number][] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(req.sample)) && matches.length < 500) {
          if (!m[0]) skipEmpty(re, req.sample);
          else matches.push([m.index, m.index + m[0].length]);
        }
        reply({ ok: true, result: { matches } });
        break;
      }
      case 'restore': {
        reply({ ok: true, result: restoreText(req.text, Mapping.from(req.mapping), req.expected) });
        break;
      }
    }
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
