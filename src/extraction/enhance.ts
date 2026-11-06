/**
 * OCR image preparation.
 *
 * Tesseract reads clean, high-contrast print well but fails on faint pencil or
 * a washed-out phone photo: on the faint test page the first pass returned
 * garbled characters, while a locally thresholded copy of the same pixels read
 * every line correctly. Rather than paying for that processing on every page,
 * the extractor only runs the second pass when the first result is unusable.
 */

export type PixelImage = { data: Uint8ClampedArray; width: number; height: number };

export type BinariseOptions = {
  /** Half-size of the local window, in pixels. */
  radius?: number;
  /** How much darker than the local mean a pixel must be to stay ink. */
  offset?: number;
};

/**
 * Adaptive (local-mean) threshold, in place.
 *
 * A global contrast stretch made photos worse, so this uses each pixel's
 * neighbourhood instead. Uint32 integral-image sums keep the whole A4 page in
 * about 30 MB even at 2400 px, which is why this stays a second pass.
 */
export function binarisePixels(image: PixelImage, options: BinariseOptions = {}): void {
  const radius = Math.max(2, Math.round(options.radius ?? 12));
  const offset = options.offset ?? 10;
  const { data, width, height } = image;
  if (width <= 0 || height <= 0) return;

  const gray = new Uint8Array(width * height);
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel++) {
    gray[pixel] = Math.round(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]);
  }

  // Summed-area table: one subtraction per window, instead of re-adding it.
  const stride = width + 1;
  const integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const row = y * width;
    const above = y * stride;
    const current = (y + 1) * stride;
    for (let x = 0; x < width; x++) {
      rowSum += gray[row + x];
      integral[current + x + 1] = integral[above + x + 1] + rowSum;
    }
  }

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    const top = y0 * stride;
    const bottom = (y1 + 1) * stride;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[bottom + x1 + 1] - integral[top + x1 + 1] - integral[bottom + x0] + integral[top + x0];
      const ink = gray[y * width + x] < sum / area - offset ? 0 : 255;
      const index = (y * width + x) * 4;
      data[index] = ink;
      data[index + 1] = ink;
      data[index + 2] = ink;
      data[index + 3] = 255;
    }
  }
}

/** True when the first OCR pass was bad enough that a cleaned copy is worth a try. */
export function needsSecondPass(quality: 'good' | 'partial' | 'poor', compactChars: number): boolean {
  return quality === 'poor' || compactChars < 40;
}
