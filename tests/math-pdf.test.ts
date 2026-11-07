/**
 * Real-document tests for the mathematical paper fixture.
 *
 * The PDF bytes in tests/fixtures/math were written by
 * scripts/make-math-fixtures.ts. Exponents are real separate glyph runs at a
 * raised baseline, the table is real positioned text, and the scan is a real
 * image-only PDF. The fixtures are synthetic reproductions of extraction
 * structure, not the user's original paper.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { normaliseExtractedText, reconstructPageLines } from '../src/extraction/layout';
import { parsePaper } from '../src/exam/paper';
import { evaluatePaper } from '../src/exam/grade';
import { decisionChat } from './helpers';

const PDF = 'tests/fixtures/math/math-paper.pdf';
const SCAN = 'tests/fixtures/math/math-paper-scan.pdf';
const available = existsSync(PDF) && existsSync(SCAN);

async function readPdf(file: string) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(file));
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages: string[] = [];
  let textCharacters = 0;
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.flatMap(item => {
        if (!('str' in item) || !Array.isArray((item as { transform?: unknown }).transform)) return [];
        const record = item as unknown as { str: string; transform: number[]; width?: number; height?: number };
        textCharacters += record.str.length;
        return [{ str: record.str, transform: record.transform, width: record.width, height: record.height }];
      });
      pages.push(reconstructPageLines(items));
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return { text: normaliseExtractedText(pages.join('\n\n')), pages: pages.length, textCharacters };
}

describe.skipIf(!available)('Class XI Mathematics paper: real PDF', () => {
  it('recognises Q1–Q7 including the mathematical Q7 and keeps 25 marks', async () => {
    const { text, textCharacters, pages } = await readPdf(PDF);
    const paper = parsePaper(text);
    expect(pages).toBe(2);
    expect(textCharacters).toBeGreaterThan(500);
    expect(paper.questions.map(question => question.ref)).toEqual([
      'Q1',
      'Q2',
      'Q3',
      'Q4',
      'Q5',
      'Q6(a)',
      'Q6(b)',
      'Q7(a)',
      'Q7(b)',
      'Q7(c)',
    ]);
    expect(paper.resolvedTotal).toBe(25);
    expect(paper.printedTotal).toBe(25);
    expect(paper.unresolvedRefs).toEqual([]);
  });

  it('preserves raised exponents, table values and a page-spanning question', async () => {
    const { text } = await readPdf(PDF);
    const paper = parsePaper(text);
    const q1 = paper.questions.find(question => question.ref === 'Q1');
    const q4 = paper.questions.find(question => question.ref === 'Q4');
    const q5 = paper.questions.find(question => question.ref === 'Q5');
    const q6a = paper.questions.find(question => question.ref === 'Q6(a)');
    const q7a = paper.questions.find(question => question.ref === 'Q7(a)');
    const q7b = paper.questions.find(question => question.ref === 'Q7(b)');
    expect(q1?.text).toContain('2^3');
    expect(q4?.text).toContain('6.02 x 10^23');
    expect(q4?.text).toContain('x 1 2 3');
    expect(q4?.text).toContain('y 2 5 10');
    expect(q5?.text).toContain('u = 20 m/s^2');
    expect(q5?.text).toContain('horizontal range');
    expect(q6a?.text).toContain('x^3 + 2x');
    expect(q7a?.text).toContain('2x^2 - 5x + 2 = 0');
    expect(q7b?.text).toContain('b^2 - 4ac');
  });

  it('marks the real mathematical PDF from bytes to a report out of 25', async () => {
    const { text } = await readPdf(PDF);
    const paper = parsePaper(text);
    const answers = `Q1. 2^3 + 1 = 9
Q2. 3x/4 = 4.5, x = 6
Q3. a = F/m = 5/2 = 2.5 m/s^2
Q4. 6.02 x 10^23
Q5. R = u^2 sin 2θ / g = 35.3 m
Q6. (a) 3x^2 + 2. (b) 3(4) + 2 = 14.
Q7. (a) (2x - 1)(x - 2) = 0. (b) b^2 - 4ac = 25 - 16 = 9. (c) x = 1/2 and x = 2.`;
    const report = await evaluatePaper({
      paper,
      answerText: answers,
      board: 'CBSE',
      grade: 'Class 11',
      chat: decisionChat((_ref, max) => ({ awarded: max, feedback: 'Correct mathematical work against the printed maximum.' })),
    });
    expect(report.paperTotal).toBe(25);
    expect(report.gradedCount).toBe(10);
    expect(report.awarded).toBe(25);
    expect(report.complete).toBe(true);
  });

  it('treats the scanned mathematical paper as a real scan with no text layer', async () => {
    const { textCharacters } = await readPdf(SCAN);
    expect(textCharacters).toBe(0);
  });
});
