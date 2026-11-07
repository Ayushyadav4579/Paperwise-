import { describe, expect, it } from 'vitest';
import {
  assessTextQuality,
  countQuestionLabels,
  joinPages,
  normaliseExtractedText,
  pageNumberFromMarker,
  needsStructureRetry,
  preferExtractedText,
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

  it('attaches a superscript to its line instead of making a separate line', () => {
    const text = reconstructPageLines([
      { str: '7. A body falls from 20 m. Take g = 9.8 m/s', transform: [1, 0, 0, 1, 50, 700], width: 200, height: 10 },
      { str: '2', transform: [1, 0, 0, 1, 250, 704], width: 4, height: 6 },
      { str: '. Find the time.', transform: [1, 0, 0, 1, 256, 700], width: 70, height: 10 },
    ]);
    expect(text.split('\n')).toEqual(['7. A body falls from 20 m. Take g = 9.8 m/s^2. Find the time.']);
  });

  it('preserves subscript geometry such as a chemical formula', () => {
    const text = reconstructPageLines([
      { str: 'Water is H', transform: [1, 0, 0, 1, 50, 700], width: 42, height: 10 },
      { str: '2', transform: [1, 0, 0, 1, 92, 697], width: 4, height: 6 },
      { str: 'O.', transform: [1, 0, 0, 1, 97, 700], width: 10, height: 10 },
    ]);
    expect(text).toBe('Water is H_2O.');
  });

  it('reads a two-column page one column at a time', () => {
    const runs = [];
    for (let index = 0; index < 12; index++) {
      runs.push({ str: `Left column sentence number ${index + 1}.`, transform: [1, 0, 0, 1, 40, 700 - index * 20], width: 200, height: 10 });
      runs.push({ str: `Right column sentence number ${index + 1}.`, transform: [1, 0, 0, 1, 340, 700 - index * 20], width: 200, height: 10 });
    }
    const lines = reconstructPageLines(runs).split('\n');
    expect(lines).toHaveLength(24);
    expect(lines[0]).toContain('Left column sentence number 1.');
    expect(lines[11]).toContain('Left column sentence number 12.');
    expect(lines[12]).toContain('Right column sentence number 1.');
  });

  it('keeps a table row together when the gaps are not a page gutter', () => {
    const runs = [];
    for (let index = 0; index < 5; index++) {
      runs.push({ str: `${index + 1}`, transform: [1, 0, 0, 1, 40, 700 - index * 20], width: 5, height: 10 });
      runs.push({ str: `${(index + 1) * 2}`, transform: [1, 0, 0, 1, 220, 700 - index * 20], width: 10, height: 10 });
      runs.push({ str: `${(index + 1) * 3}`, transform: [1, 0, 0, 1, 400, 700 - index * 20], width: 10, height: 10 });
    }
    const lines = reconstructPageLines(runs).split('\n');
    expect(lines[0]).toBe('1 2 3');
    expect(lines[4]).toBe('5 10 15');
  });
});

describe('structure comparison', () => {
  it('counts printed question labels', () => {
    expect(countQuestionLabels('1. One\n2. Two\nQ3. Three\npage 4')).toBe(3);
    expect(countQuestionLabels('The value is 2.5 and x = 3.')).toBe(0);
  });

  it('requests a second OCR pass when a readable page has no question structure', () => {
    const paperPage = 'Maximum Marks: 25\n' + 'The candidate must answer all questions. '.repeat(20);
    expect(needsStructureRetry(paperPage)).toBe(true);
    const answerPage = 'Photosynthesis converts light energy into chemical energy. '.repeat(20);
    expect(needsStructureRetry(answerPage)).toBe(false);
    expect(needsStructureRetry('1. One\n2. Two')).toBe(false);
  });

  it('prefers the extraction that finds more questions, even if shorter', () => {
    const ocr = '1. Find x. 2\n2. Find y. 3\n3. Find z. 2';
    const layer = 'Find x. Find y. Find z. Some extra watermark text.'.repeat(3);
    expect(preferExtractedText(layer, ocr)).toBe(true);
    expect(preferExtractedText(ocr, layer)).toBe(false);
    expect(preferExtractedText(ocr, ocr + ' trailing')).toBe(true);
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
