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
];
