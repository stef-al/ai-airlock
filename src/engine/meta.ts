import type { Category, Scope } from './types';

/** Static detector metadata for the settings UI (kept in sync with the real detectors by a test). */
export interface DetectorMeta {
  id: string;
  label: string;
  category: Category;
  defaultScopes: Scope[];
  tier: 1 | 2;
}

const S4: Scope[] = ['prose', 'comment', 'string', 'config'];

export const DETECTOR_META: DetectorMeta[] = [
  { id: 'secrets.known', label: 'Secrets in known formats (keys, tokens, hashes, connection strings)', category: 'secret', defaultScopes: S4, tier: 1 },
  { id: 'secrets.context', label: 'Secrets by context (names, assignments, prose)', category: 'secret', defaultScopes: S4, tier: 1 },
  { id: 'secrets.entropy', label: 'Unknown-format secrets (entropy, password shapes)', category: 'secret', defaultScopes: S4, tier: 1 },
  { id: 'contact.email', label: 'Email addresses', category: 'personal', defaultScopes: S4, tier: 1 },
  { id: 'contact.phone', label: 'Phone numbers', category: 'personal', defaultScopes: S4, tier: 1 },
  { id: 'financial.iban', label: 'IBAN (mod-97 checked)', category: 'financial', defaultScopes: S4, tier: 1 },
  { id: 'financial.card', label: 'Payment cards (Luhn) with CVV / expiry', category: 'financial', defaultScopes: S4, tier: 1 },
  { id: 'custom.lists', label: 'Always-mask lists (clients, projects, products, employees…)', category: 'custom', defaultScopes: S4, tier: 1 },
  { id: 'custom.regex', label: 'Your regex rules', category: 'custom', defaultScopes: S4, tier: 1 },
  { id: 'custom.columns', label: 'Table columns (CSV / Markdown) by header and values', category: 'custom', defaultScopes: ['prose', 'config', 'string'], tier: 1 },
  { id: 'names.person', label: 'Person names (cues, lists, derived from emails)', category: 'personal', defaultScopes: S4, tier: 2 },
  { id: 'names.org', label: 'Organizations with legal suffixes (Ltd, GmbH, s.r.o., …)', category: 'personal', defaultScopes: S4, tier: 2 },
  { id: 'network.ip', label: 'IP addresses (IPv4 / IPv6)', category: 'network', defaultScopes: S4, tier: 2 },
  { id: 'network.mac', label: 'MAC addresses', category: 'network', defaultScopes: S4, tier: 2 },
  { id: 'network.host', label: 'Hostnames under internal suffixes and company domains', category: 'network', defaultScopes: S4, tier: 2 },
  { id: 'paths.username', label: 'User names inside file paths (/home/jsmith, C:\\Users\\jsmith)', category: 'personal', defaultScopes: S4, tier: 2 },
  { id: 'personal.dob', label: 'Dates of birth next to a birth cue (DOB, geboren, né le…)', category: 'personal', defaultScopes: S4, tier: 2 },
  { id: 'ids.national', label: 'National ID numbers with checksums (US SSN, UK NI, CZ/SK birth number, PL PESEL)', category: 'personal', defaultScopes: S4, tier: 2 },
];

/** National-ID packs (kept in sync with detectors/ids by a test). */
export const ID_PACK_META: { id: string; label: string }[] = [
  { id: 'us-ssn', label: 'US Social Security number' },
  { id: 'uk-nino', label: 'UK National Insurance number' },
  { id: 'cz-sk-birth-number', label: 'Czech / Slovak birth number (rodné číslo)' },
  { id: 'pl-pesel', label: 'Polish PESEL' },
];
