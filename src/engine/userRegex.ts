// Light helpers (no heavy dependencies) shared by the UI and the detectors.

export function typeName(s: string): string {
  const t = s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return t && /^[A-Z]/.test(t) ? t : 'CUSTOM';
}


/** Heuristic ReDoS check for user supplied patterns: nested quantifiers and overlapping alternations. */
export function regexRisk(pattern: string): string | null {
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*]/.test(pattern)) return 'nested quantifier like (a+)+ can backtrack catastrophically';
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*]\s*[+*]/.test(pattern)) return 'repeated alternation';
  if (/\(\?[:=!]?[^)]*\.\*[^)]*\)\s*[+*]/.test(pattern)) return 'repeated group containing .*';
  if (pattern.length > 500) return 'pattern too long';
  return null;
}

export function compileUserRegex(pattern: string, flags: string): RegExp | string {
  if (!pattern) return 'empty pattern';
  const risk = regexRisk(pattern);
  if (risk) return risk;
  const f = [...new Set((flags || '').replace(/[^imsu]/g, '').split(''))].join('');
  try {
    return new RegExp(pattern, f + 'gd');
  } catch (e) {
    return (e as Error).message;
  }
}

