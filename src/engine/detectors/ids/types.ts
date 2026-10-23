/**
 * A national-ID pack. To add a country: create a file in this folder exporting an IdPack, then list
 * it in ./index.ts (and in ID_PACK_IDS in engine/settings.ts so it can be toggled).
 */
export interface IdMatch {
  /** span inside the regex match (default: whole match) */
  group?: number;
  conf: number;
  reason: string;
}
export interface IdPack {
  id: string;
  label: string;
  /** placeholder type (A-Z_), must also appear in CAT_OF_TYPE and KNOWN_TYPES */
  type: string;
  /** global regex; the detector runs it over the text */
  re: RegExp;
  /** words near the number that make it much more likely to be this ID */
  cue?: RegExp;
  /** return null to reject. `cue` is true when a cue word is right before the match */
  validate(m: RegExpExecArray, cue: boolean): IdMatch | null;
}

export const digitsOf = (s: string) => s.replace(/\D/g, '');

export function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}
