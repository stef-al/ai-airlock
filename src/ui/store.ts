import { defaultSettings, mergeSettings, regionFromLocale, sanitizeSettings, type Profile, type Settings } from '../engine/light';

const KEY_S = 'airlock.settings.v1';
const KEY_P = 'airlock.profiles.v1';
const KEY_A = 'airlock.profile.active';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: settings simply are not remembered */
  }
}

export function loadSettings(): Settings {
  const base = defaultSettings(regionFromLocale());
  const saved = read<unknown>(KEY_S);
  return saved ? mergeSettings(base, sanitizeSettings(saved)) : base;
}
export const saveSettings = (s: Settings) => write(KEY_S, s);
export const loadProfiles = (): Profile[] => {
  const raw = read<unknown>(KEY_P);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is { name: string; settings: unknown } => !!p && typeof p === 'object' && typeof (p as Profile).name === 'string')
    .map((p) => ({ name: p.name.slice(0, 80), settings: sanitizeSettings(p.settings) }));
};
export const saveProfiles = (p: Profile[]) => write(KEY_P, p);
export const loadActive = (): string => read<string>(KEY_A) ?? '';
export const saveActive = (n: string) => write(KEY_A, n);
