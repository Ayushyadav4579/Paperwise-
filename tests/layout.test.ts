import { describe, expect, it } from 'vitest';
import {
  assessTextQuality,
  joinPages,
  normaliseExtractedText,
  pageNumberFromMarker,
  reconstructPageLines,
  stripPageMarkers,
  validateUpload,
  MAX_FILE_BYTES,
} from '../src/extraction/layout';

function item(str: string, x: number, y: number, width = str.length * 6) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height: 10 };
}

describe('PDF text reconstruction', () => {
  it('rebuilds visual lines from positioned runs instead of flattening the page', () => {
    const text = reconstructPageLines([
      item('1. Define', 40, 700),
      item('photosynthesis.', 100, 700),
      item('2. Define', 40, 680),
      item('respiration.', 100, 680),
    ]);
    expect(text.split('\n')).toEqual(['1. Define photosynthesis.', '2. Define respiration.']);
  });

  it('sorts out-of-order text runs into reading order', () => {
    const text = reconstructPageLines([
      item('second', 40, 660),
      item('first', 40, 700),
      item('line', 90, 700),
    ]);
    expect(text.split('\n')).toEqual(['first line', 'second']);
  });

  it('keeps a gap as a space but does not insert spaces inside words', () => {
    const text = reconstructPageLines([item('photo', 40, 700, 30), item('synthesis', 71, 700)]);
    expect(text).toBe('photosynthesis');
  });

  it('returns an empty string for an empty page', () => {
    expect(reconstructPageLines([])).toBe('');
  });
});

describe('extraction quality', () => {
  it('treats real prose as good', () => {
    expect(assessTextQuality('Explain the role of hydrochloric acid in the digestion of food.')).toBe('good');
  });

  it('treats a few stray characters as poor', () => {
    expect(assessTextQuality('12')).toBe('poor');
    expect(assessTextQuality('')).toBe('poor');
  });

  it('treats partial content as partial rather than good', () => {
    expect(assessTextQuality('1. Define mass 2.')).not.toBe('good');
  });
});

describe('page handling', () => {
  it('normalises whitespace without destroying line breaks', () => {
    const text = normaliseExtractedText('1.  Define\n\n\n\n2.   Explain  ');
    expect(text.split('\n')).toEqual(['1. Define', '', '2. Explain']);
  });

  it('marks every page so problems can be reported by page number', () => {
    const text = joinPages([
      { page: 1, text: '1. Define mass.' },
      { page: 2, text: '2. Define weight.' },
      { page: 3, text: '   ' },
    ]);
    expect(text).toContain('--- Page 1 ---');
    expect(text).toContain('--- Page 2 ---');
    expect(text).not.toContain('--- Page 3 ---');
    expect(pageNumberFromMarker('--- Page 2 ---')).toBe(2);
    expect(pageNumberFromMarker('ordinary line')).toBeNull();
  });

  it('can strip page markers when plain text is needed', () => {
    const text = joinPages([
      { page: 1, text: 'First.' },
      { page: 2, text: 'Second.' },
    ]);
    expect(stripPageMarkers(text)).not.toContain('--- Page');
    expect(stripPageMarkers(text)).toContain('Second.');
  });
});

describe('upload validation', () => {
  function file(name: string, type: string, size: number) {
    return { name, type, size } as File;
  }

  it('accepts a normal PDF', () => {
    expect(validateUpload(file('paper.pdf', 'application/pdf', 1024))).toBeNull();
  });

  it('rejects an unsupported file type', () => {
    expect(validateUpload(file('virus.exe', 'application/octet-stream', 10))).toMatch(/not a supported file/i);
  });

  it('rejects an oversized file', () => {
    expect(validateUpload(file('big.pdf', 'application/pdf', MAX_FILE_BYTES + 1))).toMatch(/larger than/i);
  });

  it('rejects an empty file', () => {
    expect(validateUpload(file('empty.png', 'image/png', 0))).toMatch(/empty/i);
  });
});
