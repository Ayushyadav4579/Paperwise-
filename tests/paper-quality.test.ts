import { describe, expect, it } from 'vitest';
import { assessTextQuality } from '../src/extraction/layout';
import { parsePaper } from '../src/exam/paper';

describe('text quality', () => {
  it('counts Devanagari matras so a clean Hindi page is not called partial', () => {
    const hindi =
      'प्रश्न 1. नवीकरणीय ऊर्जा का स्रोत सौर ऊर्जा है।\n' +
      'प्रश्न 2. श्वसन वह प्रक्रिया है जिसमें भोजन टूटकर ऊर्जा देता है।\n' +
      'वायवीय श्वसन में ऑक्सीजन की आवश्यकता होती है।';
    expect(assessTextQuality(hindi)).toBe('good');
  });

  it('still rejects a page of stray symbols', () => {
    expect(assessTextQuality('||| ~~~ ### >>>')).toBe('poor');
    expect(assessTextQuality('')).toBe('poor');
  });
});

describe('printed marks on a multiple-choice question', () => {
  it('reads the mark even though the option row follows it', () => {
    const paper = parsePaper(
      [
        'SECTION A',
        '1. Which of the following is a renewable source of energy?    (1)',
        '(a) coal   (b) natural gas   (c) solar energy   (d) petrol',
        '2. Define respiration.    (2)',
      ].join('\n')
    );
    const first = paper.questions[0];
    expect(first.ref).toBe('Q1');
    expect(first.kind).toBe('objective');
    expect(first.max).toBe(1);
    expect(paper.resolvedTotal).toBe(3);
  });
});
