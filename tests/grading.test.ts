import { describe, expect, it } from 'vitest';
import {
  MarksUnresolvedError,
  buildReport,
  evaluatePaper,
  extractAnswerAt,
  findQuoteIndex,
  resolvePaperMarks,
  validateReport,
} from '../src/exam/grade';
import { paperFromManual, parsePaper } from '../src/exam/paper';
import type { ChatFn } from '../src/ai/provider';
import { AiError } from '../src/ai/errors';
import type { QuestionGrade } from '../src/exam/model';
import { decisionChat, refsInPrompt, sequenceChat, type ChatCall } from './helpers';

const PAPER = paperFromManual([
  { key: '1', prompt: 'Explain photosynthesis.', marks: 4 },
  { key: '2', prompt: 'Define respiration.', marks: 2 },
]);

const ANSWERS = `1. Green plants use sunlight, carbon dioxide and water to make glucose and release oxygen.
2. Respiration is the breakdown of glucose to release energy in cells.`;

async function mark(
  decisions: Record<string, { awarded: number; feedback?: string; confidence?: string }>,
  answers = ANSWERS,
  paper = PAPER
) {
  const calls: ChatCall[] = [];
  const report = await evaluatePaper({
    paper,
    answerText: answers,
    board: 'CBSE',
    grade: 'Class 10',
    chat: decisionChat((ref, max) => {
      const decision = decisions[ref];
      if (!decision) return null;
      return { awarded: decision.awarded, feedback: decision.feedback, confidence: decision.confidence };
    }, calls),
  });
  return { report, calls };
}

describe('grading accuracy', () => {
  it('awards full marks for a completely correct answer', async () => {
    const { report } = await mark({ Q1: { awarded: 4 }, Q2: { awarded: 2 } });
    expect(report.awarded).toBe(6);
    expect(report.gradedCount).toBe(2);
    expect(report.complete).toBe(true);
    expect(report.grades.every(grade => grade.status === 'graded')).toBe(true);
  });

  it('awards partial marks for a partly correct answer', async () => {
    const { report } = await mark({ Q1: { awarded: 2 }, Q2: { awarded: 2 } });
    expect(report.grades[0].awarded).toBe(2);
    expect(report.awarded).toBe(4);
  });

  it('awards zero for a completely incorrect answer without discarding the explanation', async () => {
    const { report } = await mark({
      Q1: { awarded: 0, feedback: 'The answer describes an unrelated process and earns no marks.' },
      Q2: { awarded: 0, feedback: 'The definition is incorrect.' },
    });
    expect(report.awarded).toBe(0);
    expect(report.grades[0].feedback.length).toBeGreaterThan(8);
    expect(report.grades[0].status).toBe('graded');
  });

  it('sends the actual question and answer to the model, so wording can differ', async () => {
    const calls: ChatCall[] = [];
    await evaluatePaper({
      paper: PAPER,
      answerText: '1. Plants trap light and turn air and water into food.\n2. Cells release energy from sugar.',
      board: 'CBSE',
      grade: 'Class 10',
      chat: decisionChat((_ref, max, messages) => {
        expect(messages.map(message => message.content).join(' ')).toContain('Explain photosynthesis');
        return { awarded: max, feedback: 'Equivalent wording earns full credit.' };
      }, calls),
    });
    const prompt = calls.map(call => call.messages.map(message => message.content).join('\n')).join('\n');
    expect(prompt).toContain('Plants trap light and turn air and water into food');
    expect(prompt).toContain('Explain photosynthesis');
    expect(prompt).toContain('Define respiration');
    expect(prompt).toContain('judge meaning and correctness, never keyword presence');
  });

  it('does not inflate a keyword-only answer with wrong reasoning', async () => {
    const { report } = await mark({
      Q1: { awarded: 0.5, feedback: 'Keywords appear but the reasoning is wrong.' },
      Q2: { awarded: 2 },
    });
    expect(report.grades[0].awarded).toBe(0.5);
    expect(report.grades[0].awarded).toBeLessThan(report.grades[0].max);
  });

  it('rejects an out-of-range mark instead of clamping it into a fake score', async () => {
    const { report } = await mark({ Q1: { awarded: 999 }, Q2: { awarded: 2 } });
    const first = report.grades.find(grade => grade.ref === 'Q1');
    expect(first?.status).toBe('unresolved');
    expect(first?.awarded).toBe(0);
    expect(report.awarded).toBe(2);
    expect(report.complete).toBe(false);
    expect(report.unresolvedCount).toBe(1);
  });

  it('marks an unanswered question as not attempted and keeps it in the total', async () => {
    const { report } = await mark({ Q1: { awarded: 3 } }, '1. Green plants make glucose from sunlight.');
    const second = report.grades.find(grade => grade.ref === 'Q2');
    expect(second?.status).toBe('unattempted');
    expect(second?.awarded).toBe(0);
    expect(report.paperTotal).toBe(6);
    expect(report.gradedMax).toBe(4);
    expect(report.awarded).toBe(3);
    expect(report.complete).toBe(true);
  });

  it('respects different maxima for different questions', async () => {
    const paper = paperFromManual([
      { key: '1', prompt: 'One mark question.', marks: 1 },
      { key: '2', prompt: 'Five mark question.', marks: 5 },
      { key: '3', prompt: 'Half mark question.', marks: 0.5 },
    ]);
    const { report } = await mark(
      { Q1: { awarded: 1 }, Q2: { awarded: 5 }, Q3: { awarded: 0.5 } },
      '1. A\n2. B\n3. C',
      paper
    );
    expect(report.grades.map(grade => grade.max)).toEqual([1, 5, 0.5]);
    expect(report.awarded).toBe(6.5);
    expect(report.paperTotal).toBe(6.5);
  });

  it('keeps section-level maxima from the uploaded paper', async () => {
    const paper = parsePaper(`SECTION A (5 × 1 = 5)
1. Define mass.
SECTION B (3 × 2 = 6)
2. Explain friction.`);
    const { report } = await mark(
      { Q1: { awarded: 1 }, Q2: { awarded: 1 } },
      '1. Mass is the amount of matter.\n2. Friction opposes motion.',
      paper
    );
    expect(report.grades.map(grade => grade.max)).toEqual([1, 2]);
    expect(report.paperTotal).toBe(3);
    expect(report.awarded).toBe(2);
  });

  it('includes an internal choice in the marking request', async () => {
    const paper = parsePaper(`1. Explain photosynthesis. (3)
OR
Explain respiration. (3)`);
    const calls: ChatCall[] = [];
    await evaluatePaper({
      paper,
      answerText: '1. Respiration releases energy from glucose.',
      board: 'CBSE',
      grade: 'Class 10',
      chat: decisionChat(() => ({ awarded: 3, feedback: 'The chosen alternative is answered correctly.' }), calls),
    });
    const prompt = calls[0].messages.map(message => message.content).join('\n');
    expect(prompt).toContain('Internal choice');
    expect(prompt).toContain('Explain respiration');
  });

  it('grades sub-questions independently', async () => {
    const paper = parsePaper(`1. Answer the following:
(a) Define transpiration. [2]
(b) Define translocation. [2]`);
    const { report } = await mark(
      { 'Q1(a)': { awarded: 2 }, 'Q1(b)': { awarded: 1 } },
      '1. (a) Transpiration is the loss of water vapour from leaves.\n(b) Translocation is the movement of food.',
      paper
    );
    expect(report.grades.map(grade => grade.ref)).toEqual(['Q1(a)', 'Q1(b)']);
    expect(report.awarded).toBe(3);
    expect(report.paperTotal).toBe(4);
  });

  it('follows an answer continued on a second page', async () => {
    const calls: ChatCall[] = [];
    await evaluatePaper({
      paper: PAPER,
      answerText: `--- Page 1 ---
1. Green plants use sunlight to make glucose.
--- Page 2 ---
They also release oxygen as a by-product.
2. Respiration releases energy.`,
      board: 'CBSE',
      grade: 'Class 10',
      chat: decisionChat((_ref, max, messages) => {
        expect(messages.map(message => message.content).join(' ')).toContain('They also release oxygen');
        return { awarded: max, feedback: 'Complete answer across both pages.' };
      }, calls),
    });
  });
});

describe('answer matching and unattempted handling', () => {
  it('matches answers written in a different order', async () => {
    const { report } = await mark(
      { Q1: { awarded: 4 }, Q2: { awarded: 2 } },
      `2. Respiration releases energy from glucose.
1. Plants use light to make food.`
    );
    expect(report.awarded).toBe(6);
    expect(report.grades.map(grade => grade.ref)).toEqual(['Q1', 'Q2']);
  });

  it('locates unlabelled answers without letting the model invent answer text', async () => {
    const answerSheet = `Green plants use sunlight, carbon dioxide and water to make glucose.
Respiration is the breakdown of glucose to release energy in cells.`;
    const calls: ChatCall[] = [];
    const chat: ChatFn = async (messages, options) => {
      calls.push({ messages, options: options as Record<string, unknown> });
      const prompt = messages.map(message => message.content).join('\n');
      if (prompt.includes('no clearly labelled answer')) {
        return {
          text: JSON.stringify({
            found: [
              { ref: 'Q1', start_quote: 'Green plants use sunlight, carbon dioxide and water' },
              { ref: 'Q2', start_quote: 'Respiration is the breakdown of glucose to release energy' },
            ],
          }),
          finishReason: 'stop',
          model: 'test',
        };
      }
      const refs = refsInPrompt(prompt);
      return {
        text: JSON.stringify({
          results: refs.map(({ ref, max }) => ({
            ref,
            awarded: max,
            correct_points: [],
            missing_points: [],
            mistakes: [],
            feedback: 'The located answer is correct.',
            confidence: 'medium',
          })),
        }),
        finishReason: 'stop',
        model: 'test',
      };
    };

    const report = await evaluatePaper({
      paper: PAPER,
      answerText: answerSheet,
      board: 'CBSE',
      grade: 'Class 10',
      chat,
    });
    expect(report.awarded).toBe(6);
    expect(report.warnings.join(' ')).toMatch(/matched by content/i);
  });

  it('finds a verbatim quote and cuts only that answer', () => {
    const source = `Some preamble.\nQ4. The answer begins here with useful facts.\nQ5. Another answer starts here.`;
    const index = findQuoteIndex(source, 'The answer begins here with useful facts');
    expect(index).toBeGreaterThan(0);
    const answer = extractAnswerAt(source, index, '4');
    expect(answer).toContain('useful facts');
    expect(answer).not.toContain('Another answer');
  });
});

describe('AI output validation and failure handling', () => {
  it('retries once when the first reply is malformed, then accepts a valid one', async () => {
    const replies = [
      'I think this deserves about half marks.',
      JSON.stringify({
        results: [
          {
            ref: 'Q1',
            awarded: 3,
            correct_points: ['names the process'],
            missing_points: [],
            mistakes: [],
            feedback: 'Mostly correct with one detail missing.',
            confidence: 'high',
          },
        ],
      }),
    ];
    const calls: ChatCall[] = [];
    const report = await evaluatePaper({
      paper: paperFromManual([{ key: '1', prompt: 'Explain photosynthesis.', marks: 4 }]),
      answerText: '1. Plants use sunlight to make glucose.',
      board: 'CBSE',
      grade: 'Class 10',
      chat: sequenceChat(replies, calls),
    });
    expect(report.awarded).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.map(message => message.content).join(' ')).toMatch(/not valid JSON/i);
  });

  it('never fabricates a mark when malformed replies persist', async () => {
    const report = await evaluatePaper({
      paper: paperFromManual([{ key: '1', prompt: 'Explain photosynthesis.', marks: 4 }]),
      answerText: '1. Plants use sunlight to make glucose.',
      board: 'CBSE',
      grade: 'Class 10',
      chat: sequenceChat(['not json', 'still not json']),
    });
    expect(report.grades[0].status).toBe('unresolved');
    expect(report.grades[0].awarded).toBe(0);
    expect(report.complete).toBe(false);
    expect(report.awarded).toBe(0);
    expect(report.grades[0].error).toBeTruthy();
  });

  it('splits a batch when one result is missing and still marks both', async () => {
    let call = 0;
    const chat: ChatFn = async messages => {
      call++;
      const prompt = messages.map(message => message.content).join('\n');
      const refs = refsInPrompt(prompt);
      const include = call === 1 ? refs.filter(ref => ref.ref !== 'Q2') : refs;
      return {
        text: JSON.stringify({
          results: include.map(({ ref, max }) => ({
            ref,
            awarded: max,
            correct_points: [],
            missing_points: [],
            mistakes: [],
            feedback: 'Correct answer.',
            confidence: 'high',
          })),
        }),
        finishReason: 'stop',
        model: 'test',
      };
    };
    const report = await evaluatePaper({
      paper: PAPER,
      answerText: ANSWERS,
      board: 'CBSE',
      grade: 'Class 10',
      chat,
    });
    expect(report.complete).toBe(true);
    expect(report.awarded).toBe(6);
  });

  it('propagates a provider failure instead of producing scores', async () => {
    const chat: ChatFn = async () => {
      throw new AiError('provider down', 'provider', { retryable: true });
    };
    await expect(
      evaluatePaper({
        paper: PAPER,
        answerText: ANSWERS,
        board: 'CBSE',
        grade: 'Class 10',
        chat,
      })
    ).rejects.toBeInstanceOf(AiError);
  });

  it('propagates a timeout instead of producing scores', async () => {
    const chat: ChatFn = async () => {
      throw new AiError('timed out', 'timeout', { retryable: true });
    };
    await expect(
      evaluatePaper({ paper: PAPER, answerText: ANSWERS, board: 'CBSE', grade: 'Class 10', chat })
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('stops immediately when marking is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      evaluatePaper({
        paper: PAPER,
        answerText: ANSWERS,
        board: 'CBSE',
        grade: 'Class 10',
        chat: decisionChat(() => ({ awarded: 0, feedback: 'Never called.' })),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses to run when a maximum mark is still unknown', async () => {
    const paper = parsePaper(`1. Explain photosynthesis.`);
    await expect(
      evaluatePaper({
        paper,
        answerText: '1. Plants make glucose.',
        board: 'CBSE',
        grade: 'Class 10',
        chat: decisionChat(() => ({ awarded: 1, feedback: 'Should not be reached.' })),
      })
    ).rejects.toBeInstanceOf(MarksUnresolvedError);
  });
});

describe('printed mark recovery', () => {
  it('accepts only evidence that actually appears in the paper', async () => {
    const paper = parsePaper(`Instructions: Each question carries 2 marks.
1. Define photosynthesis.
2. Define respiration.`);
    // The instruction gives both questions a resolved maximum, so build an
    // unresolved paper explicitly to exercise the evidence check.
    const unresolved = { ...paper, questions: paper.questions.map(question => ({ ...question, max: null as number | null, marksSource: null, marksEvidence: null })), resolvedTotal: 0, unresolvedRefs: ['Q1', 'Q2'] };
    const paperText = `General Instructions: Each question carries 2 marks.\n1. Define photosynthesis. [2]\n2. Define respiration.`;
    const chat: ChatFn = async messages => {
      expect(messages.map(message => message.content).join(' ')).toContain('Questions whose printed maximum');
      return {
        text: JSON.stringify({
          marks: [
            { ref: 'Q1', max: 2, evidence: 'Define photosynthesis. [2]' },
            { ref: 'Q2', max: 5, evidence: 'this sentence is not in the paper' },
          ],
        }),
        finishReason: 'stop',
        model: 'test',
      };
    };
    const result = await resolvePaperMarks({
      paper: unresolved,
      paperText,
      board: 'CBSE',
      grade: 'Class 10',
      chat,
    });
    expect(result.verifiedCount).toBe(1);
    expect(result.paper.questions[0].max).toBe(2);
    expect(result.paper.questions[0].marksSource).toBe('ai');
    expect(result.paper.questions[1].max).toBeNull();
    expect(result.notes.join(' ')).toMatch(/could not be found/i);
  });
});

describe('end to end on a realistic paper', () => {
  const PAPER_TEXT = `--- Page 1 ---
SUMMER EXAMINATION 2025
Class X - SCIENCE
Time: 3 hours    Maximum Marks: 16
General Instructions:
All questions are compulsory.
SECTION A (5 x 1 = 5)
1. The process by which plants make food is called:
(a) respiration (b) photosynthesis (c) transpiration (d) digestion
2. Define inertia. (1)
3. State one function of hydrochloric acid. [1]
4. Which gas is released during photosynthesis? (1)
5. Define valency. (1)
--- Page 2 ---
SECTION B (3 x 2 = 6)
6. Explain the role of the diaphragm in breathing. (2)
7. Differentiate between aerobic and anaerobic respiration. (2)
OR
Explain fermentation with an equation. (2)
8. State two properties of ionic compounds. (2)
SECTION C
9. (a) Define pH. [1]
(b) What is the pH of a neutral solution? [1]
10. Explain why sodium is stored in kerosene. (3)`;

  const ANSWER_SHEET = `--- Page 1 ---
2. Inertia is the tendency of a body to resist a change in its state of motion.
1. (b) photosynthesis
4. Oxygen.
3. It kills germs in food.
--- Page 2 ---
7. Aerobic respiration uses oxygen and releases more energy; anaerobic does not use oxygen.
8. Ionic compounds have high melting points and conduct electricity when molten.
9. (a) pH is a measure of hydrogen ion concentration.
(b) Seven.
6. The diaphragm contracts and flattens during inhalation, increasing chest volume.
--- Page 3 ---
10. Sodium reacts vigorously with oxygen and moisture in air, so it is kept under kerosene.`;

  it('reads the paper, matches out-of-order answers and marks every question', async () => {
    const paper = parsePaper(PAPER_TEXT);
    expect(paper.questions).toHaveLength(11);
    expect(paper.resolvedTotal).toBe(16);
    expect(paper.unresolvedRefs).toEqual([]);
    // The option row must stay part of one objective question.
    expect(paper.questions[0].ref).toBe('Q1');
    expect(paper.questions[0].text).toContain('photosynthesis');
    expect(paper.questions[0].text).toContain('digestion');

    const marks: Record<string, number> = {
      Q1: 1, Q2: 1, Q3: 1, Q4: 1,
      Q6: 1.5, Q7: 2, Q8: 2,
      'Q9(a)': 1, 'Q9(b)': 1, Q10: 2,
    };
    const calls: ChatCall[] = [];
    const chat = decisionChat((ref, _max, messages) => {
      if (!(ref in marks)) return null;
      // Every request must carry the real question, not just its number.
      const prompt = messages.map(message => message.content).join(' ');
      expect(prompt).toContain('maximum');
      return { awarded: marks[ref], feedback: `Assessed ${ref} against the printed question.` };
    }, calls);

    const report = await evaluatePaper({
      paper,
      answerText: ANSWER_SHEET,
      board: 'CBSE',
      grade: 'Class 10',
      chat,
    });

    expect(report.complete).toBe(true);
    expect(report.paperTotal).toBe(16);
    expect(report.awarded).toBe(13.5);
    expect(report.grades).toHaveLength(11);
    expect(report.grades.find(grade => grade.ref === 'Q5')?.status).toBe('unattempted');
    expect(report.grades.find(grade => grade.ref === 'Q10')?.max).toBe(3);
    expect(report.grades.every(grade => grade.awarded <= grade.max)).toBe(true);
    expect(report.grades.map(grade => grade.ref)).toEqual([
      'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9(a)', 'Q9(b)', 'Q10',
    ]);

    const prompt = calls.map(call => call.messages.map(message => message.content).join('\n')).join('\n');
    expect(prompt).toContain('Explain why sodium is stored in kerosene');
    expect(prompt).toContain('Explain fermentation with an equation');
    expect(prompt).toContain('Sodium reacts vigorously with oxygen');
  });
});

describe('report consistency', () => {
  it('keeps totals equal to the sum of question scores', async () => {
    const { report } = await mark({
      Q1: { awarded: 2.5 },
      Q2: { awarded: 0.5 },
    });
    expect(report.awarded).toBe(3);
    expect(report.awarded).toBe(
      report.grades.filter(grade => grade.status === 'graded').reduce((sum, grade) => sum + grade.awarded, 0)
    );
    expect(report.paperTotal).toBe(6);
  });

  it('rejects an internally inconsistent report', () => {
    const grades: QuestionGrade[] = [
      {
        key: '1',
        ref: 'Q1',
        max: 2,
        status: 'graded',
        awarded: 3,
        correctPoints: [],
        missingPoints: [],
        mistakes: [],
        feedback: 'Impossible score.',
        confidence: 'high',
        error: null,
        usedAi: true,
      },
    ];
    const report = buildReport({
      grades,
      paper: paperFromManual([{ key: '1', prompt: 'Define mass.', marks: 2 }]),
      provider: 'test',
      model: 'test',
    });
    expect(() => validateReport(report)).toThrow(/exceeds its maximum/i);
  });

  it('never shows a score above the paper total', async () => {
    const { report } = await mark({ Q1: { awarded: 4 }, Q2: { awarded: 2 } });
    expect(report.awarded).toBeLessThanOrEqual(report.paperTotal);
    expect(report.gradedMax).toBeLessThanOrEqual(report.paperTotal);
  });

  it('sorts question results into paper order', async () => {
    const { report } = await mark(
      { Q1: { awarded: 4 }, Q2: { awarded: 2 } },
      `2. Respiration answer.
1. Photosynthesis answer.`
    );
    expect(report.grades.map(grade => grade.ref)).toEqual(['Q1', 'Q2']);
  });
});
