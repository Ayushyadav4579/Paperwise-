import { afterEach, describe, expect, it } from 'vitest';
import { isHeicFile, normaliseImageFile } from '../src/heic';
import { validateUpload } from '../src/extraction/layout';

function fakeFile(name: string, type: string, bytes = 'not-really-an-image'): File {
  return new File([bytes], name, { type });
}

function stubWindow(value: unknown) {
  (globalThis as unknown as { window?: unknown }).window = value;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('iPhone HEIC uploads', () => {
  it('recognises HEIC by extension and by type', () => {
    expect(isHeicFile(fakeFile('IMG_0421.HEIC', ''))).toBe(true);
    expect(isHeicFile(fakeFile('photo.heif', 'image/heif'))).toBe(true);
    expect(isHeicFile(fakeFile('scan.jpg', 'image/jpeg'))).toBe(false);
  });

  it('accepts a HEIC file at validation instead of rejecting it', () => {
    expect(validateUpload(fakeFile('IMG_0421.HEIC', ''))).toBeNull();
  });

  it('passes a normal photo through untouched', async () => {
    const jpeg = fakeFile('scan.jpg', 'image/jpeg');
    await expect(normaliseImageFile(jpeg)).resolves.toBe(jpeg);
  });

  it('converts HEIC to a JPEG file the OCR pipeline can decode', async () => {
    stubWindow({
      heic2any: async ({ toType }: { toType?: string }) => new Blob(['jpeg-bytes'], { type: toType }),
    });
    const converted = await normaliseImageFile(fakeFile('IMG_0421.HEIC', 'image/heic'));
    expect(converted.name).toBe('IMG_0421.jpg');
    expect(converted.type).toBe('image/jpeg');
    expect(await converted.text()).toBe('jpeg-bytes');
  });

  it('explains what to do when the converter is missing', async () => {
    stubWindow({});
    await expect(
      normaliseImageFile(fakeFile('IMG_0421.HEIC', 'image/heic'), { waitMs: 300 })
    ).rejects.toThrow(/Most Compatible/);
  });

  it('does not silently return an empty image when conversion fails', async () => {
    stubWindow({
      heic2any: async () => {
        throw new Error('bad heic');
      },
    });
    await expect(normaliseImageFile(fakeFile('IMG_0421.HEIC', 'image/heic'))).rejects.toThrow(/could not be converted/);
  });
});
