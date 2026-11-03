import type { Detector, Hit } from '../types';
import { matchAll } from '../util';
import { mkHit } from './helpers';

// the payload of a base64 image; tiny ones (icons, spacers) are left alone
const DATA_IMAGE = /data:image\/(png|jpe?g|gif|webp|bmp|avif|tiff?|svg\+xml)(?:;[\w=.-]+)*;base64,([A-Za-z0-9+/_-]{200,}={0,2})/gi;

/**
 * Images embedded in text as data: URIs (Markdown, HTML, JSON, mails) would reach the chatbot
 * unchecked: their payload is masked. airlock-media.html swaps in a redacted copy of the image.
 */
export const embeddedImages: Detector = {
  id: 'media.embedded',
  label: 'Images embedded in text (data: URIs)',
  category: 'custom',
  types: ['IMAGE'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc) {
    const out: Hit[] = [];
    for (const m of matchAll(DATA_IMAGE, doc.text)) {
      const s = m.index + m[0].length - m[2].length;
      const kb = Math.round((m[2].length * 3) / 4 / 1024);
      out.push(mkHit('media.embedded', 'IMAGE', s, s + m[2].length, 0.99, `embedded ${m[1].toLowerCase()} image (${kb} kB) that may show anything`, 3, 'data-uri'));
    }
    return out;
  },
};
