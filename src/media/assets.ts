import { assetPath } from './assetList';

function fromBase64(s: string): Uint8Array {
  const U = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array };
  if (U.fromBase64) return U.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Bytes of an embedded asset, decoded on every call (callers transfer them to workers). In the
 * built file they come from an inert data block; the dev server has no CSP and serves them.
 */
export async function assetBytes(name: string): Promise<Uint8Array> {
  if (import.meta.env.DEV) {
    const path = assetPath(name);
    if (!path) throw new Error(`unknown asset ${name}`);
    const res = await fetch('/' + path);
    if (!res.ok) throw new Error(`asset ${name}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const el = document.getElementById('asset:' + name);
  if (!el) throw new Error(`asset ${name} is not embedded in this file`);
  return fromBase64(el.textContent ?? '');
}
