import { describe, expect, it } from 'vitest';
import { segmentAnswers } from '../src/exam/answers';
import { parsePaper, paperFromManual } from '../src/exam/paper';

function paperFor(refs: string[]) {
  return paperFromManual(
    refs.map((ref, index) => ({ key: ref, prompt: `Question ${ref}`, marks: 2 }))
  );
}

describe('answer-sheet segmentation', () => {
  it('matches answers written in a different order', () => {
    const paper = paperFor(['1', '2', '3']);
    const result = segmentAnswers(
      `Q3. Hydrochloric acid activates pepsin.
1. Photosynthesis converts light energy into chemical energy.
Ans 2. B then A`,
      paper
    );
    expect(result.segments.map(segment => segment.key)).toEqual(['3', '1', '2']);
    expect(result.preamble).toBe('');
  });

  it('appends an answer that continues on another page', () => {
    const paper = paperFor(['1', '2']);
    const result = segmentAnswers(
      `--- Page 1 ---
1. First half of the answer.
--- Page 2 ---
It continues here with the same question.
2. A separate answer.`,
      paper
    );
    const first = result.segments.find(segment => segment.key === '1');
    expect(first?.text).toContain('First half');
    expect(first?.text).toContain('It continues here');
    expect(result.segments.find(segment => segment.key === '2')?.text).not.toContain('continues here');
  });

  it('merges an answer that is labelled twice', () => {
    const paper = paperFor(['1']);
    const result = segmentAnswers(`1. First part.\n1. Second part.`, paper);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toContain('First part');
    expect(result.segments[0].text).toContain('Second part');
  });

  it('does not treat a decimal quantity as a question reference', () => {
    const paper = paperFor(['1', '2']);
    const result = segmentAnswers(`2.5 moles of gas were produced in the reaction.`, paper);
    expect(result.segments).toHaveLength(0);
    expect(result.preamble).toContain('2.5 moles');
  });

  it('leaves a skipped question with no segment', () => {
    const paper = paperFor(['1', '2']);
    const result = segmentAnswers(`1. Only the first answer.\n3. A number that is not in this paper.`, paper);
    expect(result.segments.map(segment => segment.key)).toEqual(['1']);
    expect(result.segments.some(segment => segment.key === '2')).toBe(false);
  });

  it('maps a leading sub-part label to the sub-question', () => {
    const paper = paperFor(['1A', '1B']);
    const result = segmentAnswers(`1. (a) Alpha is the first part.\n(b) Beta is the second part.`, paper);
    expect(result.segments.map(segment => segment.key).sort()).toEqual(['1A', '1B']);
    expect(result.segments.find(segment => segment.key === '1A')?.text).toContain('Alpha');
  });

  it('maps inline sub-references such as 2(iii)', () => {
    const paper = paperFor(['2I', '2II', '2III']);
    const result = segmentAnswers(`2(iii) Third part answer.`, paper);
    expect(result.segments[0].key).toBe('2III');
  });

  it('keeps unlabelled content before the first answer as preamble', () => {
    const paper = paperFor(['1']);
    const result = segmentAnswers(`Roll number 4231\nName: A. Student\n1. My answer.`, paper);
    expect(result.preamble).toContain('Roll number');
    expect(result.segments[0].text).toContain('My answer');
  });

  it('warns when no references can be found at all', () => {
    const paper = parsePaper(`1. Define photosynthesis. [2]`);
    const result = segmentAnswers(
      'Photosynthesis is the process by which green plants prepare food using sunlight.',
      paper
    );
    expect(result.detectedRefs).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/No answer references/i);
  });

  it('ignores a numbered step that does not exist in the paper', () => {
    const paper = paperFor(['1']);
    const result = segmentAnswers(`1. Start.\n2. This is step two of my working, not a question.`, paper);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toContain('step two');
  });
});
