// Everything the UI needs that does not pull in the detectors (keeps the main bundle small).
export * from './types';
export { Mapping, type MappingSnapshot, type Entry } from './placeholders';
export { restoreText, type RestoreReport } from './restore';
export { defaultSettings, mergeSettings, BUILTIN_PROFILES, exportProfile, parseProfile, regionFromLocale, resolveConfig, opt, DEFAULT_HOST_SUFFIXES, ID_PACK_IDS } from './settings';
export { compileUserRegex, regexRisk, typeName } from './userRegex';
export { DEFAULT_KEYWORDS, DEFAULT_QUALIFIERS } from './cues';
export { DETECTOR_META, ID_PACK_META, type DetectorMeta } from './meta';
