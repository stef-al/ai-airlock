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
  faces: opt(s, 'imgFaces', true),
  verify: opt(s, 'imgVerify', true),
  review: opt(s, 'imgReview', true),
});

/** OCR languages, QR codes and faces: the image is read again when these change. */
export const readKey = (s: Settings) => ocrLangs(s).join('+') + (imageOptions(s).qr ? '+qr' : '') + (imageOptions(s).faces ? '+faces' : '');

export const PDF_DPIS = [100, 150, 200] as const;

export const pdfOptions = (s: Settings) => {
  const dpi = Number(opt(s, 'pdfDpi', '150'));
  const max = Math.round(Number(opt(s, 'pdfMaxPages', '100')));
  return {
    /** resolution of the redacted copy's pages */
    dpi: (PDF_DPIS as readonly number[]).includes(dpi) ? dpi : 150,
    /** auto: OCR pages that show images or have (almost) no text layer */
    ocr: opt<string>(s, 'pdfOcr', 'auto') === 'always' ? ('always' as const) : ('auto' as const),
    maxPages: Number.isFinite(max) && max >= 1 ? Math.min(max, 500) : 100,
  };
};

/** A PDF is read again when these change. */
export const pdfReadKey = (s: Settings) => `${readKey(s)}|${pdfOptions(s).ocr}|${pdfOptions(s).maxPages}`;
