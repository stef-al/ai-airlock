// Images and documents exist only in airlock-media.html: in the text-only build the branch below is
// statically false, so none of the media code (OCR engine, workers, assets) is bundled.
export const MEDIA = import.meta.env.MODE === 'media';

type MediaModule = typeof import('../media/image') & typeof import('../media/mediaClient') & typeof import('../media/pdfdoc');
let loaded: Promise<MediaModule> | null = null;

export const loadMedia: () => Promise<MediaModule> =
  import.meta.env.MODE === 'media'
    ? () => (loaded ??= Promise.all([import('../media/image'), import('../media/mediaClient'), import('../media/pdfdoc')]).then(([a, b, c]) => ({ ...a, ...b, ...c })))
    : () => Promise.reject(new Error('images and documents need airlock-media.html'));
