import { describe, expect, it } from 'vitest';
import { containsVerbatim, detectQuestionKind, displayRef, parentKeyOf, refKey } from '../src/exam/text';

describe('question references', () => {
  it('normalises the many ways a question can be numbered', () => {
    expect(refKey('Q1')).toBe('1');
    expect(refKey('Question 2.')).toBe('2');
    expect(refKey('Ans 3')).toBe('3');
    expect(refKey('1(a)')).toBe('1A');
    expect(refKey('Q1(a)')).toBe('1A');
    expect(refKey('2(iii)')).toBe('2III');
    expect(refKey('4.')).toBe('4');
    expect(refKey('05')).toBe('5');
  });

  it('round-trips a key back to a display reference', () => {
    expect(displayRef('1')).toBe('Q1');
    expect(displayRef('1A')).toBe('Q1(a)');
    expect(displayRef('2III')).toBe('Q2(iii)');
    for (const key of ['1', '1A', '2III', '10']) {
      expect(refKey(displayRef(key))).toBe(key);
    }
  });

  it('derives the parent question of a sub-part', () => {
    expect(parentKeyOf('1A')).toBe('1');
    expect(parentKeyOf('12II')).toBe('12');
    expect(parentKeyOf('7')).toBe('7');
  });
});

describe('verbatim evidence', () => {
  it('accepts a quote that appears with different spacing and punctuation', () => {
    expect(containsVerbatim('Define photosynthesis. [2]', 'define   photosynthesis [2]')).toBe(true);
  });

  it('rejects an invented quote', () => {
    expect(containsVerbatim('Define photosynthesis. [2]', 'Each question carries 5 marks')).toBe(false);
  });

  it('rejects a quote that is too short to be meaningful', () => {
    expect(containsVerbatim('Define photosynthesis.', 'a')).toBe(false);
  });
});

describe('question kind detection', () => {
  it('recognises different examination question types', () => {
    expect(detectQuestionKind({ text: 'Choose the correct option for the process.', max: 1 })).toBe('objective');
    expect(detectQuestionKind({ text: 'Define mass.', max: 1 })).toBe('very-short');
    expect(detectQuestionKind({ text: 'State two functions of the stomach.', max: 2 })).toBe('short');
    expect(detectQuestionKind({ text: 'Explain the water cycle in detail.', max: 5 })).toBe('long');
    expect(detectQuestionKind({ text: 'Calculate the value of x for the given circuit.', max: 3 })).toBe('numerical');
    expect(detectQuestionKind({ text: 'Derive the expression for kinetic energy.', max: 4 })).toBe('derivation');
    expect(detectQuestionKind({ text: 'Draw a labelled diagram of the human eye.', max: 3 })).toBe('diagram');
    expect(detectQuestionKind({ text: 'Why did the poet use a metaphor here?', max: 4 })).toBe('language');
  });
});
