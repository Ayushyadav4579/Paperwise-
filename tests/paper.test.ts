import { describe, expect, it } from 'vitest';
import { parsePaper, paperFromManual, withMarksOverrides, gradeableQuestions } from '../src/exam/paper';

const CBSE_PAPER = `CBSE Class 10 Science
Time: 3 hours    Maximum Marks: 80

General Instructions:
1. All questions are compulsory.
2. Marks for each question are indicated against it.

SECTION A

1. Define photosynthesis. [1]

2. Which of the following is the correct order of the process?
(a) A then B
(b) B then A
(c) C then D
(d) D then C
[1]

SECTION B

3. Explain the role of hydrochloric acid in digestion. (2)

4. Answer the following:
(a) State one function of the stomach. [1]
(b) Name the enzyme present in saliva. [1]

5. (a) Define reflection of light.
(b) State two laws of reflection.

OR

(a) Define refraction of light.
(b) State Snell's law.
`;

function find(paper: ReturnType<typeof parsePaper>, ref: string) {
  const question = paper.questions.find(item => item.ref === ref);
  if (!question) throw new Error(`Question ${ref} was not detected. Found: ${paper.questions.map(q => q.ref).join(', ')}`);
  return question;
}

describe('question-paper parsing', () => {
  const paper = parsePaper(CBSE_PAPER);

  it('detects every question and sub-question', () => {
    expect(paper.questions.map(question => question.ref)).toEqual([
      'Q1',
      'Q2',
      'Q3',
      'Q4(a)',
      'Q4(b)',
      'Q5(a)',
      'Q5(b)',
    ]);
  });

  it('keeps the question text instead of only the reference', () => {
    expect(find(paper, 'Q1').text).toContain('Define photosynthesis');
    expect(find(paper, 'Q3').text).toContain('hydrochloric acid in digestion');
  });

  it('does not turn multiple-choice options into sub-questions', () => {
    const question = find(paper, 'Q2');
    expect(question.max).toBe(1);
    expect(question.text).toContain('(d) D then C');
    expect(question.kind).toBe('objective');
  });

  it('reads explicit per-question marks and ignores examination totals', () => {
    expect(find(paper, 'Q1').max).toBe(1);
    expect(find(paper, 'Q3').max).toBe(2);
    expect(find(paper, 'Q3').marksSource).toBe('explicit');
    expect(find(paper, 'Q4(a)').max).toBe(1);
    expect(find(paper, 'Q4(b)').max).toBe(1);
  });

  it('flags questions whose marks are genuinely not printed', () => {
    expect(find(paper, 'Q5(a)').max).toBeNull();
    expect(paper.unresolvedRefs).toEqual(['Q5(a)', 'Q5(b)']);
  });

  it('records the internal choice with the whole question', () => {
    const choice = find(paper, 'Q5(a)').choiceText ?? '';
    expect(choice).toContain('Define refraction of light');
    expect(choice).toContain("Snell's law");
  });

  it('does not treat instructions as questions', () => {
    expect(paper.questions.some(question => /compulsory/i.test(question.text))).toBe(false);
    expect(paper.rules.some(rule => /compulsory/i.test(rule))).toBe(true);
  });

  it('computes a resolved total from printed marks only', () => {
    expect(paper.resolvedTotal).toBe(6);
  });
});

describe('section and instruction mark rules', () => {
  it('reads a section distribution such as 5 x 1 = 5', () => {
    const paper = parsePaper(`SECTION A (5 × 1 = 5)
1. Define mass.
2. Define weight.
SECTION B (3 × 2 = 6)
3. Explain friction.
4. Explain gravity.`);
    expect(paper.questions.map(question => question.max)).toEqual([1, 1, 2, 2]);
    expect(paper.questions[0].marksSource).toBe('section');
    expect(paper.resolvedTotal).toBe(6);
  });

  it('applies an instruction that every question carries the same marks', () => {
    const paper = parsePaper(`General Instructions:
1. All questions are compulsory.
2. Each question carries 3 marks.

1. Explain photosynthesis.
2. Explain respiration.`);
    expect(paper.questions.map(question => question.max)).toEqual([3, 3]);
    expect(paper.questions[0].marksSource).toBe('instruction');
  });

  it('never applies a section total as the mark for each question', () => {
    const paper = parsePaper(`SECTION C

30 marks

1. Explain the water cycle.`);
    expect(paper.questions[0].max).toBeNull();
  });

  it('reads Hindi mark labels', () => {
    const paper = parsePaper(`1. प्रकाश संश्लेषण को परिभाषित करें। 2 अंक
2. श्वसन को समझाएँ। 3 अंक`);
    expect(paper.questions.map(question => question.max)).toEqual([2, 3]);
  });
});

describe('structure edge cases', () => {
  it('keeps a question together across a page break', () => {
    const paper = parsePaper(`--- Page 1 ---
1. Calculate the value of x when
--- Page 2 ---
2x + 3 = 11. [2]`);
    expect(paper.questions).toHaveLength(1);
    expect(paper.questions[0].text).toContain('Calculate the value of x');
    expect(paper.questions[0].text).toContain('2x + 3 = 11');
    expect(paper.questions[0].max).toBe(2);
  });

  it('does not read mathematical notation as printed marks', () => {
    const paper = parsePaper(`1. Evaluate f(2) for the given function.`);
    expect(paper.questions[0].max).toBeNull();
  });

  it('does not split a calculation such as 2 x 3 = 6 into a mark distribution', () => {
    const paper = parsePaper(`1. A rectangle has sides 2 × 3 = 6. Find its area.`);
    expect(paper.questions[0].max).toBeNull();
  });

  it('supports roman-numeral sub-parts', () => {
    const paper = parsePaper(`1. Answer the following:
(i) Define transpiration. [1]
(ii) Define translocation. [1]`);
    expect(paper.questions.map(question => question.ref)).toEqual(['Q1(i)', 'Q1(ii)']);
    expect(paper.questions.every(question => question.max === 1)).toBe(true);
  });

  it('warns instead of inventing marks when only a parent total is printed', () => {
    const paper = parsePaper(`1. Answer the following. [5]
(a) Define A.
(b) Define B.`);
    expect(paper.questions.map(question => question.max)).toEqual([null, null]);
    expect(paper.warnings.join(' ')).toMatch(/could not be found/i);
  });
});

describe('mark overrides', () => {
  it('uses only marks the student explicitly confirmed', () => {
    const paper = parsePaper(`1. Define A.
2. Define B. [2]`);
    expect(paper.unresolvedRefs).toEqual(['Q1']);
    const updated = withMarksOverrides(paper, { 1: 3 });
    expect(updated.questions[0].max).toBe(3);
    expect(updated.questions[0].marksSource).toBe('manual');
    expect(updated.unresolvedRefs).toEqual([]);
    expect(updated.resolvedTotal).toBe(5);
  });

  it('ignores invalid overrides rather than inventing a maximum', () => {
    const paper = parsePaper(`1. Define A.`);
    const updated = withMarksOverrides(paper, { 1: 0 });
    expect(updated.questions[0].max).toBeNull();
  });
});

describe('manual papers', () => {
  it('builds a gradeable paper with independent maxima', () => {
    const paper = paperFromManual([
      { key: '1', prompt: 'Define photosynthesis.', marks: 2, criteria: 'light energy; glucose' },
      { key: '2', prompt: 'Explain respiration.', marks: 5 },
    ]);
    expect(gradeableQuestions(paper)).toHaveLength(2);
    expect(paper.questions[0].max).toBe(2);
    expect(paper.questions[1].max).toBe(5);
    expect(paper.questions[0].markingPoints).toContain('glucose');
  });

  it('does not create a question from an empty row', () => {
    const paper = paperFromManual([{ key: '1', prompt: '   ', marks: 2 }]);
    expect(paper.questions).toHaveLength(0);
  });
});
