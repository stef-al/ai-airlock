/**
 * A national-ID pack. To add a country: create a file in this folder exporting an IdPack, then list
 * it in ./index.ts (and in ID_PACK_IDS in engine/settings.ts so it can be toggled).
 */
export interface IdMatch {
  /** span inside the regex match (default: whole match) */
  group?: number;
  conf: number;
  reason: string;
  /** a bare digit run with no cue: only reported in Aggressive mode */
  needsCue?: boolean;
}
export interface IdPack {
  id: string;
  label: string;
  /** placeholder type (A-Z_), must also appear in CAT_OF_TYPE and KNOWN_TYPES */
  type: string;
  /** global regex; the detector runs it over the text */
  re: RegExp;
  /** words right before the number that make it much more likely to be this ID */
  cue?: RegExp;
  /** key names (JSON/YAML/CSV header…) that hold this ID */
  keyCue?: RegExp;
  /** return null to reject. `cue` is true when a cue word is right before the match */
  validate(m: RegExpExecArray, cue: boolean): IdMatch | null;
}

export const digitsOf = (s: string) => s.replace(/\D/g, '');

export function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

/** 1111111111, 1234567890: test data, not an ID */
export function dummyDigits(d: string): boolean {
  if (/^(\d)\1+$/.test(d)) return true;
  const up = '01234567890123456789';
  const down = '98765432109876543210';
  return up.includes(d) || down.includes(d);
}
