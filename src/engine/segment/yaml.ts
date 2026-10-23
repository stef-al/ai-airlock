import { isMap, isPair, isScalar, isSeq, parseAllDocuments, Scalar, type Node as YNode } from 'yaml';
import type { Pair, SegScope } from '../types';
import { SegBuilder } from '../util';
import type { Part } from './part';
import { segmentKv } from './kv';

interface Item {
  start: number;
  end: number;
  scope: SegScope;
  quote?: string;
  vt?: 'str' | 'num' | 'lit';
  bare?: boolean;
}

export function segmentYaml(text: string): Part {
  let docs;
  try {
    docs = parseAllDocuments(text, { keepSourceTokens: false, prettyErrors: false, strict: false });
  } catch {
    return segmentKv(text, 'yaml-lite');
  }
  const items: Item[] = [];
  const pairs: Pair[] = [];
  let errors = 0;
  const docList = Array.isArray(docs) ? docs : [docs];

  for (const d of docList) {
    errors += d.errors.length;
    const docPairs: Pair[] = [];
    let isSecret = false;

    const scalarSpan = (s: Scalar): { start: number; end: number; quote: string; bare: boolean } | null => {
      if (!s.range) return null;
      const [rs, re] = s.range;
      switch (s.type) {
        case Scalar.QUOTE_DOUBLE:
          return { start: rs + 1, end: Math.max(rs + 1, re - 1), quote: '"', bare: false };
        case Scalar.QUOTE_SINGLE:
          return { start: rs + 1, end: Math.max(rs + 1, re - 1), quote: "'", bare: false };
        case Scalar.BLOCK_LITERAL:
        case Scalar.BLOCK_FOLDED: {
          const nl = text.indexOf('\n', rs);
          if (nl < 0 || nl >= re) return null;
          return { start: nl + 1, end: re, quote: 'block', bare: false };
        }
        default: {
          let e = re;
          while (e > rs && /\s/.test(text[e - 1])) e--;
          return { start: rs, end: e, quote: '', bare: true };
        }
      }
    };

    const addValue = (s: Scalar, key: string, keyNode: Scalar | null, path: string) => {
      const sp = scalarSpan(s);
      if (!sp || sp.end <= sp.start) return;
      const raw = s.value;
      const vt = typeof raw === 'number' ? 'num' : typeof raw === 'string' ? 'str' : 'lit';
      items.push({ start: sp.start, end: sp.end, scope: 'config', quote: sp.quote, vt, bare: sp.bare });
      const ks = keyNode?.range;
      docPairs.push({
        key,
        keyStart: ks ? ks[0] : sp.start,
        keyEnd: ks ? ks[1] : sp.start,
        valStart: sp.start,
        valEnd: sp.end,
        quote: sp.quote,
        numeric: typeof raw === 'number',
        path,
        kind: 'kv',
      });
    };

    const walk = (node: unknown, key: string, keyNode: Scalar | null, path: string) => {
      if (isScalar(node)) {
        addValue(node, key, keyNode, path);
      } else if (isMap(node)) {
        for (const p of node.items) {
          if (!isPair(p)) continue;
          const k = p.key as YNode | null;
          if (!isScalar(k)) {
            walk(p.value, key, keyNode, path);
            continue;
          }
          const kn = k as Scalar;
          const ksp = scalarSpan(kn);
          if (ksp && ksp.end > ksp.start) items.push({ start: ksp.start, end: ksp.end, scope: 'key' });
          const kt = String(kn.value);
          walk(p.value, kt, kn, path ? path + '.' + kt : kt);
        }
      } else if (isSeq(node)) {
        for (const it of node.items) walk(it, key, keyNode, path);
      }
    };
    const root = d.contents;
    walk(root, '', null, '');
    if (isMap(root)) {
      const kind = root.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === 'kind');
      if (kind && isPair(kind) && isScalar(kind.value) && kind.value.value === 'Secret') isSecret = true;
    }
    for (const p of docPairs) {
      if (isSecret && /^(data|stringData)\./.test(p.path ?? '')) p.hint = 'k8s-secret';
      if (/(^|\.)auths\./.test(p.path ?? '')) p.hint = 'docker-auth';
      pairs.push(p);
    }
  }

  // comments: '#' preceded by whitespace/line start and outside any scalar
  items.sort((a, b) => a.start - b.start);
  const comments: Item[] = [];
  let ip = 0;
  let idx = text.indexOf('#');
  while (idx >= 0) {
    while (ip < items.length && items[ip].end <= idx) ip++;
    const inside = ip < items.length && items[ip].start <= idx && idx < items[ip].end;
    const prev = idx === 0 ? '\n' : text[idx - 1];
    if (!inside && /\s/.test(prev)) {
      let e = text.indexOf('\n', idx);
      if (e < 0) e = text.length;
      if (text[e - 1] === '\r') e--;
      comments.push({ start: idx, end: e, scope: 'comment' });
      idx = text.indexOf('#', e);
    } else idx = text.indexOf('#', idx + 1);
  }
  const all = items.concat(comments).sort((a, b) => a.start - b.start);
  const b = new SegBuilder(text.length);
  for (const it of all) b.add(it.start, it.end, it.scope, { quote: it.quote, vt: it.vt, bare: it.bare });
  return { segments: b.finish(), pairs, columns: [], errors };
}
