import { ID_PACK_IDS, opt } from '../../settings';
import { SENS_RANK, type Detector, type Hit } from '../../types';
import { groupSpan, matchAll } from '../../util';
import { mkHit } from '../helpers';
import { czSkBirthNumber, plPesel, ukNino, usSsn } from './packs';
import type { IdPack } from './types';

export const ID_PACKS: IdPack[] = [usSsn, ukNino, czSkBirthNumber, plPesel];

export const idsDetector: Detector = {
  id: 'ids.national',
  label: 'National ID numbers with checksums (US SSN, UK NI, CZ/SK birth number, PL PESEL)',
  category: 'personal',
  types: ID_PACKS.map((p) => p.type),
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc, cfg, ctx) {
    const off = new Set(opt(ctx.settings, 'idPacksOff', [] as string[]));
    const out: Hit[] = [];
    const t = doc.text;
    const rank = SENS_RANK[cfg.sensitivity];
    for (const p of ID_PACKS) {
      if (off.has(p.id)) continue;
      ctx.check();
      for (const m of matchAll(p.re, t)) {
        const cue = !!p.cue && p.cue.test(t.slice(Math.max(0, m.index - 36), m.index));
        const v = p.validate(m, cue);
        if (!v) continue;
        if (rank < SENS_RANK.balanced && v.conf < 0.9) continue;
        const g = v.group ? groupSpan(m, v.group) : null;
        const s = g ? g[0] : m.index;
        out.push(mkHit('ids.national', p.type, s, g ? g[1] : m.index + m[0].length, v.conf, v.reason, 3, p.id));
      }
    }
    return out;
  },
};

export { ID_PACK_IDS };
