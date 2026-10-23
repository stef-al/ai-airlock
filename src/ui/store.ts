import { defaultSettings, mergeSettings, regionFromLocale, type Profile, type Settings } from '../engine/light';

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
  const saved = read<Partial<Settings>>(KEY_S);
  return saved ? mergeSettings(base, saved) : base;
}
export const saveSettings = (s: Settings) => write(KEY_S, s);
export const loadProfiles = (): Profile[] => read<Profile[]>(KEY_P) ?? [];
export const saveProfiles = (p: Profile[]) => write(KEY_P, p);
export const loadActive = (): string => read<string>(KEY_A) ?? '';
export const saveActive = (n: string) => write(KEY_A, n);
