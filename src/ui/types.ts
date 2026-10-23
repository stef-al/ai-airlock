import type { Doc, Hit } from '../engine/light';
import type { MaskRes } from '../worker/protocol';

export interface DocState {
  id: string;
  name: string;
  text: string;
  /** bumps on every edit so stale analyses can be dropped */
  ver: number;
  editing: boolean;
  status: 'idle' | 'analyzing' | 'ready' | 'error';
  error?: string;
  format?: Doc['format'];
  lang?: Doc['lang'];
  ms?: number;
  hits: Hit[];
  /** "start:text" of findings the user chose to keep this time */
  keep: string[];
  /** findings the user added by selecting text ("mask once") */
  extra: Hit[];
  result?: MaskRes;
  mver: number;
  maskedVer: number;
}

export const hitKey = (text: string, h: Hit) => h.start + ':' + text.slice(h.start, h.end);

/** User picks beat automatic findings. */
export function selectedHits(d: DocState): Hit[] {
  const kept = new Set(d.keep);
  const auto = d.hits.filter((h) => !kept.has(hitKey(d.text, h)));
  const extra = [...d.extra].sort((a, b) => a.start - b.start);
  const out: Hit[] = [];
  for (const x of extra) if (!out.length || out[out.length - 1].end <= x.start) out.push(x);
  const free = auto.filter((h) => !out.some((x) => x.start < h.end && x.end > h.start));
  return [...out, ...free].sort((a, b) => a.start - b.start);
}
