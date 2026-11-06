import { describe, expect, it } from 'vitest';
import { MAX_QUESTIONS_PER_RUN, evaluatePaper, retryUnresolvedQuestions } from '../src/exam/grade';
import { paperFromManual } from '../src/exam/paper';
import { decisionChat } from './helpers';

function paper(size: number) {
  const questions = Array.from({ length: size }, (_, index) => ({
    key: String(index + 1),
    prompt: `Explain concept ${index + 1}.`,
    marks: 2,
    criteria: '',
  }));
  return paperFromManual(questions, 'CBSE');
}

function answers(size: number) {
  return Array.from({ length: size }, (_, index) => `${index + 1}. Concept ${index + 1} explained.`).join('\n\n');
}

describe('large papers', () => {
  it('marks a 61-question paper instead of refusing it at 60', async () => {
    expect(MAX_QUESTIONS_PER_RUN).toBeGreaterThanOrEqual(200);
    const report = await evaluatePaper({
      paper: paper(61),
      answerText: answers(61),
      board: 'CBSE',
      grade: 'Class 10',
      chat: decisionChat(() => ({ awarded: 1, feedback: 'One relevant point was made.' })),
    });
    expect(report.grades.length).toBe(61);
    expect(report.gradedCount).toBe(61);
    expect(report.awarded).toBe(61);
    expect(report.complete).toBe(true);
  }, 20_000);

  it('refuses only a paper beyond the documented ceiling', async () => {
    const huge = paper(MAX_QUESTIONS_PER_RUN + 1);
    await expect(
      evaluatePaper({
        paper: huge,
        answerText: answers(MAX_QUESTIONS_PER_RUN + 1),
        board: '',
        grade: '',
        chat: decisionChat(() => ({ awarded: 1, feedback: 'One relevant point was made.' })),
      })
    ).rejects.toThrow(/up to 300/);
  }, 20_000);
});

describe('retrying only the unfinished answers', () => {
  it('keeps verified marks and re-marks just the failed question', async () => {
    const testPaper = paper(3);
    const first = await evaluatePaper({
      paper: testPaper,
      answerText: answers(3),
      board: 'CBSE',
      grade: 'Class 10',
      chat: decisionChat((ref, max) =>
        ref === 'Q3'
          ? { awarded: max + 5, feedback: 'This mark is impossible.' }
          : { awarded: 1.5, feedback: 'The main idea is correct.' }
      ),
    });

    expect(first.grades.map(grade => grade.status)).toEqual(['graded', 'graded', 'unresolved']);
    expect(first.complete).toBe(false);
    expect(first.awarded).toBe(3);

    const retryCalls: string[] = [];
    const retryChat = decisionChat((ref, max) => {
      retryCalls.push(ref);
      return { awarded: max, feedback: 'Both required points are present.' };
    });
    const second = await retryUnresolvedQuestions({
      report: first,
      answerText: answers(3),
      board: 'CBSE',
      grade: 'Class 10',
      chat: retryChat,
    });

    expect(retryCalls).toEqual(['Q3']);
    expect(second.complete).toBe(true);
    expect(second.grades.map(grade => grade.status)).toEqual(['graded', 'graded', 'graded']);
    expect(second.awarded).toBe(5);
    expect(second.gradedMax).toBe(6);
    // The two already-verified marks are reused, not recalculated.
    expect(second.grades[0].awarded).toBe(1.5);
    expect(second.grades[1].awarded).toBe(1.5);
  }, 20_000);

  it('does nothing when every answer was already marked', async () => {
    const testPaper = paper(2);
    const report = await evaluatePaper({
      paper: testPaper,
      answerText: answers(2),
      board: '',
      grade: '',
      chat: decisionChat(() => ({ awarded: 1, feedback: 'A correct point was made.' })),
    });
    let called = false;
    const again = await retryUnresolvedQuestions({
      report,
      answerText: answers(2),
      board: '',
      grade: '',
      chat: async () => {
        called = true;
        throw new Error('should not be called');
      },
    });
    expect(called).toBe(false);
    expect(again).toBe(report);
  });
});
