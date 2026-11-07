/**
 * Mathematical question-recognition benchmark.
 *
 * These fixtures are synthetic text that reproduces extraction patterns seen in
 * real papers (merged lines, OCR glyph confusion, equations on their own
 * lines). The real PDF and OCR counterparts live in math-pdf.test.ts and
 * real-documents.test.ts.
 *
 * Every case asserts the question number, complete text, expression, parts,
 * marks, original order and that no mathematical value became a question.
 */
import { describe, expect, it } from 'vitest';
import { parsePaper } from '../src/exam/paper';
import type { Paper } from '../src/exam/model';

function refs(paper: Paper): string[] {
  return paper.questions.map(question => question.ref);
}

function question(paper: Paper, ref: string) {
  const found = paper.questions.find(item => item.ref === ref);
  expect(found, `${ref} should exist`).toBeDefined();
  return found!;
}

function total(paper: Paper): number {
  return paper.questions.reduce((sum, item) => sum + (item.max ?? 0), 0);
}

describe('mathematical question recognition', () => {
  it('keeps several numerical values inside one Physics question', () => {
    const paper = parsePaper(`SECTION A
Maximum Marks: 25
1. A car of mass 1200 kg accelerates from 10 m/s to 25 m/s in 5 s. Calculate the force. 3
2. A stone is dropped from 45 m. Take g = 9.8 m/s^2. Find the time of fall. 3`);
    expect(refs(paper)).toEqual(['Q1', 'Q2']);
    expect(question(paper, 'Q1').text).toContain('1200 kg');
    expect(question(paper, 'Q1').text).toContain('10 m/s to 25 m/s');
    expect(question(paper, 'Q1').max).toBe(3);
    expect(question(paper, 'Q2').text).toContain('9.8 m/s^2');
    expect(paper.printedTotal).toBe(25);
  });

  it('keeps multiple equations in their original order', () => {
    const paper = parsePaper(`3. Solve the system of equations:
2x + 3y = 12
4x - y = 5
Find x and y. 4`);
    expect(refs(paper)).toEqual(['Q3']);
    const text = question(paper, 'Q3').text;
    expect(text).toContain('2x + 3y = 12');
    expect(text).toContain('4x - y = 5');
    expect(text.indexOf('2x + 3y')).toBeLessThan(text.indexOf('4x - y'));
    expect(question(paper, 'Q3').max).toBe(4);
    expect(total(paper)).toBe(4);
  });

  it('preserves fractions and decimals and does not read them as labels', () => {
    const paper = parsePaper(`4. Simplify (3/4)x + 0.25x - 1.5 and evaluate at x = 2.5. 2`);
    expect(refs(paper)).toEqual(['Q4']);
    expect(question(paper, 'Q4').text).toContain('(3/4)x');
    expect(question(paper, 'Q4').text).toContain('0.25x');
    expect(question(paper, 'Q4').text).toContain('2.5');
    expect(question(paper, 'Q4').max).toBe(2);
  });

  it('preserves powers, roots and operators', () => {
    const paper = parsePaper(`5. Evaluate √(16) + 2^3 + 10^2 - ∛27. 3`);
    expect(refs(paper)).toEqual(['Q5']);
    expect(question(paper, 'Q5').text).toContain('√(16)');
    expect(question(paper, 'Q5').text).toContain('2^3');
    expect(question(paper, 'Q5').text).toContain('10^2');
    expect(question(paper, 'Q5').max).toBe(3);
  });

  it('keeps negative numbers as values, not question numbers', () => {
    const paper = parsePaper(`6. The temperature falls from -5 °C to -12 °C. A lift moves at -3 m/s. Find the change. 3`);
    expect(refs(paper)).toEqual(['Q6']);
    expect(question(paper, 'Q6').text).toContain('-5 °C');
    expect(question(paper, 'Q6').text).toContain('-12 °C');
    expect(question(paper, 'Q6').text).toContain('-3 m/s');
    expect(question(paper, 'Q6').max).toBe(3);
  });

  it('keeps scientific notation with exponents and units', () => {
    const paper = parsePaper(`7. A sample contains 6.02 × 10^23 molecules and carries 1.6 × 10^-19 C. Find the ratio. 3`);
    expect(refs(paper)).toEqual(['Q7']);
    expect(question(paper, 'Q7').text).toContain('6.02 × 10^23');
    expect(question(paper, 'Q7').text).toContain('1.6 × 10^-19 C');
    expect(question(paper, 'Q7').max).toBe(3);
  });

  it('keeps vector notation and compound units', () => {
    const paper = parsePaper(`8. A force F = (3i + 4j) N acts on a 2 kg body. Find its magnitude in N and acceleration in m/s^2. 3`);
    expect(refs(paper)).toEqual(['Q8']);
    expect(question(paper, 'Q8').text).toContain('(3i + 4j) N');
    expect(question(paper, 'Q8').text).toContain('m/s^2');
    expect(question(paper, 'Q8').max).toBe(3);
  });

  it('segments a multi-part mathematical question and keeps the parent stem', () => {
    const paper = parsePaper(`9. A projectile is launched with u = 20 m/s at 30°.
(a) Find the time of flight. 2
(b) Find the maximum height H = u^2 sin^2 θ / 2g. 3
(c) Find the range R = u^2 sin 2θ / g. 3`);
    expect(refs(paper)).toEqual(['Q9(a)', 'Q9(b)', 'Q9(c)']);
    expect(question(paper, 'Q9(a)').max).toBe(2);
    expect(question(paper, 'Q9(b)').text).toContain('u^2 sin^2 θ / 2g');
    expect(question(paper, 'Q9(b)').max).toBe(3);
    expect(question(paper, 'Q9(b)').parentText).toContain('u = 20 m/s at 30°');
    expect(total(paper)).toBe(8);
  });

  it('keeps an equation block that spans several lines attached to its question', () => {
    const paper = parsePaper(`10. For the circuit shown:
V = IR
R = R1 + R2
I = V / (R1 + R2)
calculate the current when V = 12 V, R1 = 2 Ω and R2 = 4 Ω. 3`);
    expect(refs(paper)).toEqual(['Q10']);
    const text = question(paper, 'Q10').text;
    expect(text.indexOf('V = IR')).toBeLessThan(text.indexOf('R = R1 + R2'));
    expect(text).toContain('I = V / (R1 + R2)');
    expect(text).toContain('R2 = 4 Ω');
    expect(question(paper, 'Q10').max).toBe(3);
  });

  it('recognises a question whose statement begins with a mathematical expression', () => {
    const paper = parsePaper(`11. 2x + 3 = 11. Find x. 2
12. 3 kg of water at 20 °C is heated. Find the heat needed. 3`);
    expect(refs(paper)).toEqual(['Q11', 'Q12']);
    expect(question(paper, 'Q11').text).toContain('2x + 3 = 11');
    expect(question(paper, 'Q11').max).toBe(2);
    expect(question(paper, 'Q12').text).toContain('3 kg');
    expect(question(paper, 'Q12').max).toBe(3);
  });

  it('rejoins a merged line when the next question starts with a quantity', () => {
    const paper = parsePaper(`6. The final reading is 8.4 7. 2 kg of ice absorbs 6.72 × 10^4 J. Find the mass that melts. 3`);
    expect(refs(paper)).toEqual(['Q6', 'Q7']);
    expect(question(paper, 'Q7').text).toContain('2 kg of ice');
    expect(question(paper, 'Q7').text).toContain('6.72 × 10^4 J');
    expect(question(paper, 'Q7').max).toBe(3);
  });

  it('treats numbered calculation steps as steps, not new questions', () => {
    const paper = parsePaper(`12. Solve and show your working. 5
1. Write the equation 2x + 3 = 11.
2. Subtract 3 from both sides.
3. Divide both sides by 2.`);
    expect(refs(paper)).toEqual(['Q12']);
    const text = question(paper, 'Q12').text;
    expect(text).toContain('1. Write the equation 2x + 3 = 11');
    expect(text).toContain('2. Subtract 3 from both sides');
    expect(text).toContain('3. Divide both sides by 2');
    expect(question(paper, 'Q12').max).toBe(5);
  });

  it('does not let a numbered step swallow the next question when no mark is printed', () => {
    const paper = parsePaper(`1. Add the following numbers.
1. 2 + 3 + 4
2. Differentiate x^3. 3`);
    expect(refs(paper)).toEqual(['Q1', 'Q2']);
    expect(question(paper, 'Q2').text).toContain('Differentiate x^3');
    expect(question(paper, 'Q1').text).toContain('2 + 3 + 4');
  });

  it('keeps a two-step list inside its low-numbered question', () => {
    const paper = parsePaper(`1. Find the value of x. 4
1. Add 3 to both sides to get 2x = 8.
2. Divide both sides by 2.`);
    expect(refs(paper)).toEqual(['Q1']);
    expect(question(paper, 'Q1').text).toContain('2x = 8');
    expect(question(paper, 'Q1').text).toContain('Divide both sides by 2');
    expect(question(paper, 'Q1').max).toBe(4);
  });

  it('treats equation numbers in brackets as part of the question', () => {
    const paper = parsePaper(`5. Solve:
(1) 2x = 4
(2) x + 1 = 3
6. Differentiate x^3 + 2x. 3`);
    expect(refs(paper)).toEqual(['Q5', 'Q6']);
    expect(question(paper, 'Q5').text).toContain('(1) 2x = 4');
    expect(question(paper, 'Q5').text).toContain('(2) x + 1 = 3');
    expect(question(paper, 'Q6').max).toBe(3);
  });

  it('keeps a numeric table inside its question instead of creating questions', () => {
    const paper = parsePaper(`13. The table shows readings of x and y.
x 1 2 3
y 4 5 6
2 4 6 8
Find y when x = 3. 3`);
    expect(refs(paper)).toEqual(['Q13']);
    const text = question(paper, 'Q13').text;
    expect(text).toContain('x 1 2 3');
    expect(text).toContain('y 4 5 6');
    expect(text).toContain('2 4 6 8');
    expect(question(paper, 'Q13').max).toBe(3);
  });

  it('keeps an equation that continues across a page boundary in one question', () => {
    const paper = parsePaper(`--- Page 1 ---
14. The equation of motion is
v^2 = u^2 + 2as
--- Page 2 ---
where u = 0, a = 2 m/s^2 and s = 10 m. Find v. 3`);
    expect(refs(paper)).toEqual(['Q14']);
    expect(question(paper, 'Q14').text).toContain('v^2 = u^2 + 2as');
    expect(question(paper, 'Q14').text).toContain('s = 10 m');
    expect(question(paper, 'Q14').max).toBe(3);
    expect(question(paper, 'Q14').page).toBe(1);
    expect(question(paper, 'Q14').pageLine).toBeGreaterThan(0);
  });

  it('accepts OCR glyph confusion around mathematical equations', () => {
    const paper = parsePaper(`0l. Find x if 2x + 3 = 7. 2
O2. A body moves with v = 3 m/s. Find t if s = 12 m. 3`);
    expect(refs(paper)).toEqual(['Q1', 'Q2']);
    expect(question(paper, 'Q1').text).toContain('2x + 3 = 7');
    expect(question(paper, 'Q2').text).toContain('v = 3 m/s');
    expect(question(paper, 'Q2').max).toBe(3);
  });

  it('reads a mixed Hindi–English mathematical paper', () => {
    const paper = parsePaper(`SECTION A
1. यदि 2x + 3 = 11 है, तो x का मान ज्ञात कीजिए। 2
2. A body moves with v = 5 m/s for 4 s. Find the distance. 3
3. सिद्ध कीजिए कि (a + b)^2 = a^2 + 2ab + b^2. 3`);
    expect(refs(paper)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(question(paper, 'Q1').text).toContain('2x + 3 = 11');
    expect(question(paper, 'Q2').text).toContain('v = 5 m/s');
    expect(question(paper, 'Q3').text).toContain('(a + b)^2 = a^2 + 2ab + b^2');
    expect(total(paper)).toBe(8);
  });

  it('does not split a question at a mathematical value followed by a comma', () => {
    const paper = parsePaper(`1. If f(x) = x + 2, find f(2). 2
2. A vector is 5 N at 30 degrees. Find its components. 3`);
    expect(refs(paper)).toEqual(['Q1', 'Q2']);
    expect(question(paper, 'Q1').text).toBe('If f(x) = x + 2, find f(2).');
    expect(question(paper, 'Q1').max).toBe(2);
    expect(question(paper, 'Q2').max).toBe(3);
  });

  it('flags unreadable mathematical notation instead of dropping it', () => {
    const paper = parsePaper(`1. The force is F = ?? N and the mass is 2 kg?? Find F. 3`);
    expect(refs(paper)).toEqual(['Q1']);
    expect(paper.warnings.some(warning => /notation in Q1/.test(warning))).toBe(true);
  });

  it('keeps the printed denominator when a mathematical question is lost', () => {
    const paper = parsePaper(`Maximum Marks: 25
1. Calculate the value of 2 + 2. 2
3. Solve 3x = 9. 3`);
    expect(refs(paper)).toEqual(['Q1', 'Q3']);
    expect(paper.printedTotal).toBe(25);
    expect(paper.warnings.some(warning => /Question number 2 is missing/.test(warning))).toBe(true);
    expect(paper.warnings.some(warning => /states a total of 25/.test(warning))).toBe(true);
  });
});
