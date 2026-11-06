/**
 * iPhone HEIC/HEIF support.
 *
 * iPhones save camera photos as HEIC, and no browser except Safari can decode
 * it. Those students would upload a file that is accepted by the picker and
 * then fail in OCR, so the file is converted to JPEG in the browser first.
 * The converter (heic2any, ~1.3 MB) is fetched from a CDN only when a HEIC
 * file is actually uploaded, so normal desktop and Android uploads never pay
 * for it.
 */

const CONVERTER_URL = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';

type HeicConverter = (options: { blob: Blob; toType?: string; quality?: number }) => Promise<Blob | Blob[]>;

declare global {
  interface Window {
    heic2any?: HeicConverter;
  }
}

const HEIC_NAME = /\.(heic|heif)$/i;
const HEIC_TYPE = /^image\/hei[cf]/i;

export function isHeicFile(file: { name: string; type: string }): boolean {
  return HEIC_TYPE.test(file.type) || HEIC_NAME.test(file.name);
}

let loading: Promise<HeicConverter | null> | null = null;

function loadConverter(): Promise<HeicConverter | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (typeof window.heic2any === 'function') return Promise.resolve(window.heic2any);
  if (typeof document === 'undefined') return Promise.resolve(null);
  loading ??= new Promise<HeicConverter | null>(resolve => {
    const script = document.createElement('script');
    script.src = CONVERTER_URL;
    script.async = true;
    script.onload = () => resolve(typeof window.heic2any === 'function' ? window.heic2any : null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return loading;
}

async function waitForConverter(timeoutMs = 10_000): Promise<HeicConverter | null> {
  const stalled = new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs));
  const converter = (await Promise.race([loadConverter(), stalled])) ?? null;
  // A failed or timed-out load is not cached, so the next HEIC upload tries
  // the CDN again instead of failing forever for the rest of the session.
  if (!converter) loading = null;
  return converter;
}

/**
 * Return a JPEG the rest of the pipeline can decode. Non-HEIC files pass
 * through untouched; a HEIC file that cannot be converted throws a message
 * that tells the student what to do instead.
 */
export async function normaliseImageFile(file: File, options: { waitMs?: number } = {}): Promise<File> {
  if (!isHeicFile(file)) return file;

  const convert = await waitForConverter(options.waitMs);
  if (!convert) {
    throw new Error(
      `${file.name} is an iPhone HEIC photo, and the converter could not load. Reload Paperwise with an internet connection, or set your camera to "Most Compatible" and upload a JPG.`
    );
  }

  let converted: Blob | Blob[];
  try {
    converted = await convert({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  } catch {
    throw new Error(
      `${file.name} could not be converted from HEIC. Re-export it as a JPG, or set your iPhone camera to "Most Compatible" and take the photo again.`
    );
  }
  const blob = Array.isArray(converted) ? converted[0] : converted;
  if (!blob) throw new Error(`${file.name} produced no image when converted from HEIC.`);
  const renamed = file.name.replace(HEIC_NAME, '.jpg');
  return new File([blob], renamed, { type: 'image/jpeg', lastModified: Date.now() });
}
