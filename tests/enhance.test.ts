import { describe, expect, it } from 'vitest';
import { binarisePixels, needsSecondPass } from '../src/extraction/enhance';

/** Paint a light-grey "ink" word on a slightly lighter paper background. */
function faintDocument(width = 90, height = 30) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  // Uneven paper lighting, which is why a global threshold fails.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const paper = 232 - Math.round((x / width) * 26);
      data[index] = paper;
      data[index + 1] = paper;
      data[index + 2] = paper - 2;
    }
  }
  // Two horizontal strokes of faint pencil (about #8a8a8a on #e0e0e0).
  for (const row of [8, 20]) {
    for (let x = 10; x < 80; x++) {
      const index = (row * width + x) * 4;
      data[index] = 138;
      data[index + 1] = 138;
      data[index + 2] = 140;
    }
  }
  return { data, width, height };
}

describe('OCR image enhancement', () => {
  it('turns faint, unevenly lit strokes into black ink on white', () => {
    const image = faintDocument();
    binarisePixels(image);
    const ink = (x: number, y: number) => image.data[(y * image.width + x) * 4];
    expect(ink(30, 8)).toBe(0);
    expect(ink(30, 20)).toBe(0);
    expect(ink(30, 14)).toBe(255);
    // Paper at both ends of the gradient must stay white.
    expect(ink(2, 2)).toBe(255);
    expect(ink(image.width - 3, image.height - 3)).toBe(255);
  });

  it('keeps the dimensions and opaque alpha of the page', () => {
    const image = faintDocument(40, 12);
    binarisePixels(image);
    expect(image.data.length).toBe(40 * 12 * 4);
    for (let index = 3; index < image.data.length; index += 4) expect(image.data[index]).toBe(255);
  });

  it('does not binarise a clean page into noise', () => {
    const width = 60;
    const height = 20;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let x = 5; x < 55; x++) {
      const index = (10 * width + x) * 4;
      data[index] = 10;
      data[index + 1] = 10;
      data[index + 2] = 10;
    }
    const image = { data, width, height };
    binarisePixels(image);
    const whites = Array.from({ length: width * height }, (_, pixel) => image.data[pixel * 4]).filter(
      value => value === 255
    );
    expect(whites.length).toBeGreaterThan(width * height - 60);
  });

  it('only asks for a second pass when the first OCR result is unusable', () => {
    expect(needsSecondPass('good', 900)).toBe(false);
    expect(needsSecondPass('partial', 300)).toBe(false);
    expect(needsSecondPass('poor', 300)).toBe(true);
    expect(needsSecondPass('good', 12)).toBe(true);
  });
});
