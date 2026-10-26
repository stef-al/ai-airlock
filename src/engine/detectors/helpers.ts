import { KeyAnalyzer } from '../cues';
import type { Category, Doc, Hit, Settings } from '../types';

export const CAT_OF_TYPE: Record<string, Category> = {
  PASSWORD: 'secret', SECRET: 'secret', TOKEN: 'secret', API_KEY: 'secret', PIN: 'secret', JWT: 'secret',
  PRIVATE_KEY: 'secret', PASSWORD_HASH: 'secret', COOKIE: 'secret',
  EMAIL: 'personal', PHONE: 'personal', PERSON: 'personal', ORG: 'personal', DOB: 'personal', SSN: 'personal',
  NATIONAL_ID: 'personal', USERNAME: 'personal', NINO: 'personal', BIRTH_NUMBER: 'personal', PESEL: 'personal',
  IBAN: 'financial', CARD: 'financial', CVV: 'financial', CARD_EXPIRY: 'financial',
  IP: 'network', IPV6: 'network', MAC: 'network', HOST: 'network',
};

export function mkHit(
  detector: string,
  type: string,
  start: number,
  end: number,
  confidence: number,
  reason: string,
  priority: number,
  rule?: string,
  category?: Category,
): Hit {
  return {
    start,
    end,
    detector,
    type,
    category: category ?? CAT_OF_TYPE[type] ?? 'custom',
    confidence: Math.min(0.99, Math.round(confidence * 100) / 100),
    reason,
    priority,
    rule,
  };
}

const analyzers = new Map<string, KeyAnalyzer>();
export function analyzerFor(s: Settings): KeyAnalyzer {
  const k = s.keywords.join('\u0001') + '\u0002' + s.qualifiers.join('\u0001');
  let a = analyzers.get(k);
  if (!a) {
    if (analyzers.size > 8) analyzers.clear();
    a = new KeyAnalyzer(s.keywords, s.qualifiers);
    analyzers.set(k, a);
  }
  return a;
}

const LANG_NAME: Record<string, string> = {
  js: 'JavaScript', ts: 'TypeScript', python: 'Python', java: 'Java', csharp: 'C#', go: 'Go', php: 'PHP',
  sql: 'SQL', bash: 'shell script', powershell: 'PowerShell',
};
const FMT_NAME: Record<string, string> = {
  json: 'JSON', yaml: 'YAML', xml: 'XML', env: '.env', ini: 'INI', properties: 'properties file', csv: 'CSV',
  markdown: 'Markdown', log: 'log', prose: 'text',
};

export function formatLabel(doc: Doc): string {
  if (doc.format === 'code') return LANG_NAME[doc.lang ?? ''] ?? 'code';
  return FMT_NAME[doc.format] ?? doc.format;
}

export function isStructured(doc: Doc): boolean {
  return doc.format !== 'prose' && doc.format !== 'log' && doc.format !== 'markdown';
}

/** Hash-set of start offsets for fast duplicate skipping. */
export function sortHits(h: Hit[]): Hit[] {
  return h.sort((a, b) => a.start - b.start || b.end - a.end);
}
