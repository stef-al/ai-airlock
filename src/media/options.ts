// Image options in Settings.options (pure: the settings screen of the text-only build reads them too).
import { opt, type Settings } from '../engine/light';
import { OCR_LANGS, type OcrLang } from './assetList';

export const OCR_LANG_NAMES: Record<OcrLang, string> = { eng: 'English', deu: 'German', fra: 'French', spa: 'Spanish', ita: 'Italian', pol: 'Polish', ces: 'Czech' };

const LANG_OF: Record<string, OcrLang> = { en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pl: 'pol', cs: 'ces' };

/** English plus the browser's language when it is one of the bundled ones. */
export function defaultOcrLangs(): OcrLang[] {
  const l = LANG_OF[(typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2).toLowerCase()];
  return l && l !== 'eng' ? ['eng', l] : ['eng'];
}

export function ocrLangs(s: Settings): OcrLang[] {
  const v = opt(s, 'ocrLangs', defaultOcrLangs() as string[]).filter((x): x is OcrLang => (OCR_LANGS as readonly string[]).includes(x));
  return v.length ? v : ['eng'];
}

export const imageOptions = (s: Settings) => ({
  labels: opt(s, 'imgLabels', true),
  pad: Number(opt(s, 'imgPad', '0.2')) || 0.2,
  allText: opt(s, 'imgAllText', false),
  qr: opt(s, 'imgQr', true),
  verify: opt(s, 'imgVerify', true),
  review: opt(s, 'imgReview', true),
});

/** OCR languages and QR scanning: the image is read again when these change. */
export const readKey = (s: Settings) => ocrLangs(s).join('+') + (imageOptions(s).qr ? '+qr' : '');
