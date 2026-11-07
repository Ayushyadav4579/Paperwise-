import type { MarksSource, Paper, PaperQuestion, PaperSection } from './model';
import { cleanInline, detectQuestionKind, displayRef, isRoman, parentKeyOf, toLines } from './text';
import { pageNumberFromMarker } from '../extraction/layout';

/**
 * Deterministic examination-paper parser.
 *
 * Marks are only ever taken from something actually printed on the paper:
 * a per-question mark, a section distribution (`3 x 2 = 6`), or an examination
 * instruction ("each question carries 2 marks"). When none of those exists the
 * question is left unresolved instead of guessing, and the UI asks the student
 * to confirm the marks.
 *
 * Question boundaries are the fragile part of real papers. PDF text layers and
 * OCR both merge lines, so a question number is not always at the start of a
 * line: `... (d) mass 1 2. The slope ...` is one extracted line containing two
 * questions. The parser therefore expands a line whenever the *next expected*
 * question number appears inside it, which is far safer than splitting on any
 * `digit + dot`.
 */

const SECTION_RE = /^(?:section|part|भाग|खंड)\s*[-–—:]?\s*([A-Za-z0-9]{1,3})\b(.*)$/i;
// OCR reads a printed `Q` as `O` or `0`, so all three are accepted as a label.
const QUESTION_LABEL = '(?:q(?:uestion)?|प्रश्न|o|0)';
// A question number is a line-leading number with a separator. `(?!\d)` after
// the separator rejects decimals such as `1.5 moles` without rejecting
// `1. 25 ml of acid ...`.
const QUESTION_START_RE = new RegExp(
  `^(${QUESTION_LABEL}\\s*[.:]?\\s*)?\\(?(\\d{1,3}|[lI])\\)?\\s*([.):\\],;:\\-–—])(?!\\d)\\s*(.*)$`,
  'i'
);
// `Q4 Explain ...` without punctuation is accepted only with an explicit label,
// so a wrapped sentence beginning with a number is not a question.
const QUESTION_SPACED_RE = new RegExp(
  `^(${QUESTION_LABEL})\\s*[.:]?\\s*(\\d{1,3})\\s+(?=[^\\d\\s])(.*)$`,
  'i'
);
// A question number in the middle of an extracted line. OCR frequently reads
// `Q` as `O` or `0`, so those prefixes are accepted. Inline labels are only
// trusted with a `.` or `)` and a new sentence-like token: `x + 2, find ...` is
// a mathematical value, not a question boundary.
const INLINE_START_RE = new RegExp(
  `(^|[\\s])(${QUESTION_LABEL}\\s*[.:]?\\s*)?(\\d{1,3})\\s*([.)])(?!\\d)\\s*(?=[A-Z(\\[\\"'“”‘’√∛−\\u0900-\\u097F]|\\d+(?:\\.\\d+)?\\s+[A-Za-z(])`,
  'gi'
);
const MCQs = /\b(?:choose|select|tick|which\s+of\s+the\s+following|correct\s+option|multiple\s+choice)\b/i;
const SUBPART_RE = /^\(([a-h])\)\s*(.*)$/i;
const ROMAN_SUBPART_RE = /^\((i|ii|iii|iv|v|vi|vii|viii|ix|x)\)\s*(.*)$/i;
const CHOICE_RE = /^(?:or|अथवा)\b\s*[.:;,\-–—]?\s*(.*)$/i;
const DISTRIBUTION_RE = /\b(\d{1,2})\s*[x×*]\s*(\d{1,2})\s*=\s*(\d{1,3})\b/i;
const EACH_MARKS_RE =
  /(?:each|every|प्रत्येक|all)\s+(?:of\s+the\s+)?(?:questions?|one\s+question)?[^.\n]{0,60}?(\d{1,3}(?:\.\d+)?)\s*(?:marks?|अंक)/i;
// Require whitespace before the bracket so mathematical notation such as
// `f(2)` or `x(3)` is never read as a printed mark.
const TRAILING_MARKS_RE = /(?:^|\s)[\[(]\s*(\d{1,3}(?:\.\d+)?)\s*(?:marks?|अंक|m|M)?\s*[\])]\s*$/;
const WORD_MARKS_RE = /\b(\d{1,3}(?:\.\d+)?)\s*(?:marks?|अंक)/i;
// A mark distribution is printed in brackets or at the very end, not in the
// middle of a calculation.
const TRAILING_DISTRIBUTION_RE =
  /(?:[\[(]\s*\d{1,2}\s*[x×*]\s*\d{1,2}\s*=\s*\d{1,3}\s*[\])]|\b\d{1,2}\s*[x×*]\s*\d{1,2}\s*=\s*\d{1,3})\s*$/i;
const INSTRUCTION_HEADER_RE = /^(?:general\s+)?instructions?\b|^instructions?\s+to\s+(?:the\s+)?candidates?/i;
const INSTRUCTION_LINE_RE =
  /\b(?:attempt|compulsory|carry|carries|marks?|write|answer\s+all|question\s+paper|time\s+allowed|internal\s+choice|choose|section|read\s+the\s+following|all\s+questions|each\s+question|blue|black|dark|pencil|diagram|total)\b/i;
const PAGE_NUMBER_RE = /^(?:page\s*)?\d{1,3}\s*(?:\||\/|of)\s*(?:page\s*)?\d{1,3}$|^page\s+\d{1,3}$/i;

type MarksInfo = { max: number; evidence: string };

type Draft = {
  number: number;
  key: string;
  label: string;
  /** Answer options were seen, so parentheses are not sub-parts. */
  mcq: boolean;
  lines: string[];
  choiceLines: string[] | null;
  section: string;
  /** Marks rule that was active in this question's own section. */
  sectionMarks: MarksInfo | null;
  page: number | null;
  /** Line number within the page, kept as the question's source location. */
  pageLine: number | null;
  parts: Draft[];
};

type SectionDraft = PaperSection & { key: string };

function clampMarks(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
  return Math.round(value * 100) / 100;
}

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  let found: RegExpMatchArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    found = match;
    if (match.index === regex.lastIndex) regex.lastIndex++;
  }
  return found;
}

function questionNumber(raw: string, hasPrefix: boolean): number | null {
  if (/^[lI]$/.test(raw)) return hasPrefix ? 1 : null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) return null;
  return value;
}

/** Parse a question number at the very start of a line. */
function questionStart(line: string): { number: number; rest: string } | null {
  const match = line.match(QUESTION_START_RE);
  if (match) {
    const number = questionNumber(match[2], !!match[1]);
    if (number !== null) return { number, rest: cleanInline(match[4] ?? '') };
  }
  const spaced = line.match(QUESTION_SPACED_RE);
  if (spaced) {
    const number = questionNumber(spaced[2], true);
    if (number !== null) return { number, rest: cleanInline(spaced[3] ?? '') };
  }
  return null;
}

/** Every place in a line that looks like the start of a numbered question. */
function inlineStarts(line: string): Array<{ number: number; index: number }> {
  const found: Array<{ number: number; index: number }> = [];
  const regex = new RegExp(INLINE_START_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    const number = questionNumber(match[3], !!match[2]);
    if (match[0].length === 0) regex.lastIndex++;
    if (number === null) continue;
    const index = match.index + (match[1]?.length ?? 0);
    // `x = 2. Find ...` is a value followed by a new sentence, not a question
    // label. Only a boundary after a value, closing bracket or mark may start
    // a question in the middle of a line.
    const before = line.slice(0, index).trimEnd();
    if (/[=+\-−×÷/*^<>(\[{,]\s*$/.test(before)) continue;
    // A question may itself start with a quantity (`7. 2 kg of ice ...`). In a
    // merged line that is only trusted when the previous token is a printed
    // mark or value, never a bare word (`the value 7. 2 kg`).
    const after = line.slice(match.index + match[0].length);
    if (/^\d+(?:\.\d+)?\s+[A-Za-z(]/.test(after) && !/[\d)\]\.]\s*$/.test(before)) continue;
    found.push({ number, index });
  }
  return found;
}

/** A table/data row such as `2 4 6 8` must not start a question from its `2`. */
function looksLikeDataRow(line: string): boolean {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 4) return false;
  const numeric = tokens.filter(token => /^[-+]?\d+(?:\.\d+)?$/.test(token)).length;
  return numeric >= tokens.length - 1;
}

/**
 * Split one extracted line into the questions it actually contains.
 *
 * Only the *next expected* numbers are accepted, so text such as `2.5 moles`,
 * `20 m/s`, `Fig. 3` and page numbers cannot start a question. Returns `[line]`
 * when there is nothing to split.
 */
function expandLine(line: string, expected: number): string[] {
  const starts = inlineStarts(line);
  const cuts: number[] = [];
  let next = expected;
  for (const start of starts) {
    if (start.number !== next) continue;
    cuts.push(start.index);
    next += 1;
  }
  const splits = cuts.filter((cut, index) => cut > 0 || index < cuts.length - 1);
  if (!splits.length) return [line];
  const pieces: string[] = [];
  if (cuts[0] > 0) pieces.push(line.slice(0, cuts[0]));
  cuts.forEach((cut, index) => {
    const piece = line.slice(cut, cuts[index + 1] ?? line.length).trim();
    if (piece) pieces.push(piece);
  });
  return pieces.length ? pieces : [line];
}

type PartRun = { stem: string; parts: Array<{ label: string; text: string }> };

/**
 * Split `6. A projectile ... (a) time of flight. 2 (b) height. 3` into a stem
 * and parts. A row of MCQ options such as `(a) speed (b) velocity ... 1` looks
 * similar, so a run only counts as sub-parts when at least two segments carry
 * their own printed mark.
 */
function splitPartRun(text: string, usesRoman: boolean): PartRun | null {
  const markers = [...text.matchAll(/\(([a-h]|i{1,3}|iv|v|vi{1,3}|ix|x)\)\s*/gi)];
  if (markers.length < 2) return null;
  const labels = markers.map(match => match[1].toLowerCase());
  const roman = labels.every(label => isRoman(label));
  const letters = labels.every(label => /^[a-h]$/.test(label));
  if (!roman && !letters) return null;
  const sequence = roman ? ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'] : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const startAt = sequence.indexOf(labels[0]);
  if (startAt < 0) return null;
  for (let index = 0; index < labels.length; index++) {
    if (sequence[startAt + index] !== labels[index]) return null;
  }
  if (roman && !usesRoman) return null;
  const parts = markers.map((marker, index) => {
    const from = marker.index! + marker[0].length;
    const to = markers[index + 1]?.index ?? text.length;
    return { label: marker[1].toLowerCase(), text: cleanInline(text.slice(from, to)) };
  });
  if (parts.some(part => part.text.length < 2)) return null;
  const marked = parts.filter(part => bareTrailingMarks(part.text, false) !== null).length;
  if (marked < 2) return null;
  return { stem: cleanInline(text.slice(0, markers[0].index)), parts };
}

function looksLikeOptionRow(line: string): boolean {
  const labels = [...line.matchAll(/(?:^|\s)\(([a-h])\)\s+/gi)].map(match => match[1].toLowerCase());
  if (labels.length < 3) return false;
  return new Set(labels).size >= 3;
}

/**
 * Marks printed as a plain trailing number, e.g. `... maximum height. 1`.
 * A bare number is only trusted after sentence punctuation, or at the end of an
 * option row (`(d) mass 1`). This keeps `speed of 20`, `g = 10` and years out.
 */
function bareTrailingMarks(text: string, optionRow: boolean): MarksInfo | null {
  const match = text.match(/(\d{1,2}(?:\.\d+)?)\s*$/);
  if (!match || match.index === undefined) return null;
  const max = clampMarks(Number(match[1]));
  if (max === null || max > 20) return null;
  const before = text.slice(0, match.index).trimEnd();
  if (before.length < 8) return null;
  // The danda (।) ends Hindi sentences, just like a full stop.
  if (!optionRow && !/[.?!:;)\]।]$/.test(before)) return null;
  return { max, evidence: `“${before.slice(-32)} ${match[1]}”` };
}

function marksFromText(lines: string[]): MarksInfo | null {
  // An MCQ's option row comes after the printed mark, e.g.
  // "1. Which ...? (1)" followed by "(a) coal (b) gas ...". Reading option rows
  // as marks was avoided before, but a paper may print the mark at the end of
  // the option row, so those lines are used explicitly below.
  const optionRow = lines.find(line => looksLikeOptionRow(line)) ?? null;
  const stem = lines.filter(line => !looksLikeOptionRow(line));
  const text = cleanInline(stem.join(' '));
  const full = cleanInline(lines.join(' '));

  const distribution = text.match(TRAILING_DISTRIBUTION_RE);
  if (distribution) {
    const parts = distribution[0].match(DISTRIBUTION_RE);
    const total = clampMarks(Number(parts?.[3] ?? NaN));
    if (total !== null) return { max: total, evidence: distribution[0].trim() };
  }

  const tail = text.slice(-48);
  const trailing = tail.match(TRAILING_MARKS_RE);
  if (trailing) {
    const max = clampMarks(Number(trailing[1]));
    if (max !== null) return { max, evidence: trailing[0].trim() };
  }

  const word = lastMatch(text.slice(-80), WORD_MARKS_RE);
  if (word) {
    const max = clampMarks(Number(word[1]));
    if (max !== null) return { max, evidence: word[0] };
  }

  if (optionRow) {
    const rowMark = bareTrailingMarks(full, true);
    if (rowMark) return rowMark;
  }
  const combined = bareTrailingMarks(text, false);
  if (combined) return combined;
  // Calculation steps after the statement push the printed mark away from the
  // end of the question, so a mark at the end of any of its own lines counts.
  for (const line of stem) {
    const strong = line.slice(-48).match(TRAILING_MARKS_RE) ?? lastMatch(line.slice(-80), WORD_MARKS_RE);
    if (!strong) continue;
    const max = clampMarks(Number(strong[1]));
    if (max !== null) return { max, evidence: strong[0].trim() };
  }
  for (const line of stem) {
    const bare = bareTrailingMarks(line, false);
    if (bare) return bare;
  }
  return null;
}

function stripMarksMarker(text: string): string {
  return cleanInline(
    text
      .replace(TRAILING_MARKS_RE, '')
      .replace(TRAILING_DISTRIBUTION_RE, '')
      .replace(/\s*[\[(]\s*\d{1,3}(?:\.\d+)?\s*(?:marks?|अंक|m|M)?\s*[\])]\s*$/gim, ' ')
      // A plain mark after sentence punctuation is not part of the question.
      // The multiline flag also removes it when calculation steps follow.
      .replace(/([.?!:;)\]।])\s+\d{1,2}(?:\.\d+)?[ \t]*$/gm, '$1')
  );
}

/**
 * Remove a bare mark printed at the end of an option row. Only the resolved
 * mark itself is removed: a numeric table ending in `10` must stay in the
 * question even when the mark is `3`.
 */
function stripBareOptionMark(text: string, marks: MarksInfo | null): string {
  if (!marks) return text;
  const match = text.match(/\s+(\d{1,2}(?:\.\d+)?)\s*$/);
  if (!match || match.index === undefined || Number(match[1]) !== marks.max) return text;
  return cleanInline(text.slice(0, match.index));
}

/** Extract per-question marks printed once for a whole section header. */
function sectionMarksPerQuestion(tail: string): MarksInfo | null {
  const distribution = tail.match(/\b(\d{1,2})\s*[x×*]\s*(\d{1,2})\s*=\s*(\d{1,3})\b/i);
  if (distribution) {
    const each = clampMarks(Number(distribution[2]));
    if (each !== null) return { max: each, evidence: distribution[0] };
  }
  const eachMarks = tail.match(EACH_MARKS_RE);
  if (eachMarks) {
    const max = clampMarks(Number(eachMarks[1]));
    if (max !== null) return { max, evidence: eachMarks[0] };
  }
  return null;
}

function globalMarksFromRule(rule: string): MarksInfo | null {
  const match = rule.match(
    /(?:all|each|every)\s+(?:of\s+the\s+)?questions?[^.\n]{0,50}?(\d{1,3}(?:\.\d+)?)\s*(?:marks?|अंक)/i
  );
  if (!match) return null;
  const max = clampMarks(Number(match[1]));
  return max === null ? null : { max, evidence: match[0] };
}

function subpartLabel(line: string, usesRoman: boolean, existingParts: Draft[]): { label: string; rest: string } | null {
  const roman = line.match(ROMAN_SUBPART_RE);
  const letter = line.match(SUBPART_RE);
  if (!roman && !letter) return null;

  const existingRoman = existingParts.length > 0 && existingParts.every(part => isRoman(part.label));
  const existingLetter = existingParts.length > 0 && existingParts.every(part => !isRoman(part.label));

  if (roman) {
    const label = roman[1].toLowerCase();
    const multiChar = label.length > 1;
    const preferRoman = multiChar || existingRoman || (!existingLetter && usesRoman);
    if (preferRoman || !letter) return { label, rest: roman[2] };
  }
  if (letter) return { label: letter[1].toLowerCase(), rest: letter[2] };
  return null;
}

function buildQuestionText(lines: string[]): string {
  // Strip per line: a mark printed after the statement is left behind when
  // numbered calculation steps follow it, and joining first would hide it.
  return cleanInline(lines.map(line => stripMarksMarker(line)).join(' '));
}

/**
 * A multi-part question usually prints one total (8) and no per-part marks, or
 * per-part marks and no total. When only the total is printed, the total is
 * divided across the parts so the paper total stays correct; the split is
 * reported to the student rather than hidden.
 */
function allocateMarks(total: number, values: Array<number | null>): number[] | null {
  const missing = values.filter(value => value === null).length;
  if (!missing) return null;
  const known = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const cents = Math.round((total - known) * 100);
  if (cents <= 0) return null;
  const each = Math.floor(cents / missing);
  let extra = cents - each * missing;
  return values.map(value => {
    if (value !== null) return value;
    const share = each + (extra-- > 0 ? 1 : 0);
    return share / 100;
  });
}

export function parsePaper(rawText: string): Paper {
  const warnings: string[] = [];
  const rules: string[] = [];
  const sections: SectionDraft[] = [];
  const tops: Draft[] = [];
  let currentSection: SectionDraft | null = null;
  let sectionMarks: MarksInfo | null = null;
  let globalMarks: MarksInfo | null = null;
  let page: number | null = null;
  let inInstructions = false;
  let currentTop: Draft | null = null;
  let currentPart: Draft | null = null;
  let inChoice = false;
  let expected = 1;
  // Highest question number seen in this section. A number that does not move
  // forward is a numbered calculation step or an equation label, not a new
  // question. Section numbering may restart, so this resets per section.
  let sectionHighest = 0;
  // When a numbered step is detected, its successors stay steps until a line
  // with its own printed marks proves it is a real question.
  let stepMode: number | null = null;
  let pageLine = 0;

  const lines = toLines(rawText);
  const usesRoman = /\((?:ii|iii|iv|vi|vii|viii|ix)\)/i.test(rawText);

  const startTop = (number: number): Draft => {
    const key = String(number);
    const draft: Draft = {
      number,
      key,
      label: '',
      lines: [],
      choiceLines: null,
      section: currentSection?.name ?? '',
      sectionMarks,
      page,
      pageLine,
      parts: [],
      mcq: false,
    };
    tops.push(draft);
    currentTop = draft;
    currentPart = null;
    inChoice = false;
    expected = number + 1;
    sectionHighest = Math.max(sectionHighest, number);
    stepMode = null;
    return draft;
  };

  const startPart = (parent: Draft, label: string, rest: string): Draft => {
    const key = `${parent.number}${label.toUpperCase()}`;
    const draft: Draft = {
      number: parent.number,
      key,
      label,
      lines: rest ? [rest] : [],
      choiceLines: null,
      section: parent.section,
      sectionMarks: parent.sectionMarks,
      page,
      pageLine,
      parts: [],
      mcq: false,
    };
    parent.parts.push(draft);
    currentPart = draft;
    inChoice = false;
    return draft;
  };

  const appendText = (text: string) => {
    // Everything after a printed "OR" belongs to the alternative option of the
    // whole question, not to the last sub-part that happened to be open.
    if (inChoice && currentTop?.choiceLines) {
      currentTop.choiceLines.push(text);
      return;
    }
    const target = currentPart ?? currentTop;
    if (!target) return;
    target.lines.push(text);
  };

  /** Turn an inline `(a) ... 2 (b) ... 3` run into real sub-parts. */
  const consumePartRun = (parent: Draft, text: string): boolean => {
    const run = splitPartRun(text, usesRoman);
    if (!run) return false;
    if (run.stem) parent.lines.push(run.stem);
    for (const part of run.parts) startPart(parent, part.label, part.text);
    return true;
  };

  const isMultipleChoice = (draft: Draft | null): boolean =>
    !!draft && (draft.mcq || MCQs.test(draft.lines.join(' ')));

  // Split-off pieces are already known to be question starts, so they must not
  // be re-classified as numbered steps.
  const pending: Array<{ text: string; forced: boolean }> = [];
  for (let index = 0; index < lines.length || pending.length; ) {
    const entry = pending.length ? pending.shift()! : { text: lines[index++], forced: false };
    const rawLine = entry.text;
    const forced = entry.forced;
    let trimmed = rawLine.trim();
    if (!trimmed) continue;

    const markerPage = pageNumberFromMarker(trimmed);
    if (markerPage !== null) {
      page = markerPage;
      pageLine = 0;
      continue;
    }
    pageLine += 1;

    // Break `... 1 2. The slope ...` into two questions before any other rule
    // sees it. Instructions are exempt because their numbered rules would
    // otherwise be mistaken for question numbers, and a numbered calculation
    // step is left whole.
    if (!inInstructions) {
      const start = questionStart(trimmed);
      const stepLikeStart = start !== null && !forced && currentTop !== null && start.number <= sectionHighest;
      if (!stepLikeStart) {
        const base = start && start.number > sectionHighest ? start.number + 1 : expected;
        const pieces = expandLine(trimmed, base);
        if (pieces.length > 1) {
          trimmed = pieces[0].trim();
          if (!trimmed) continue;
          pending.unshift(...pieces.slice(1).map(text => ({ text, forced: true })));
        }
      }
    }

    const sectionMatch = trimmed.length <= 160 ? trimmed.match(SECTION_RE) : null;
    if (sectionMatch) {
      const tail = sectionMatch[2] ?? '';
      const marks = sectionMarksPerQuestion(tail);
      const section: SectionDraft = {
        key: `section-${sections.length}`,
        name: `Section ${sectionMatch[1].toUpperCase()}`,
        marksPerQuestion: marks?.max ?? null,
        note: cleanInline(tail),
      };
      sections.push(section);
      currentSection = section;
      sectionMarks = marks;
      inInstructions = false;
      // A new section always begins a new question group. Numbering may also
      // restart, so the ascending rule is scoped to the section.
      sectionHighest = 0;
      stepMode = null;
      currentTop = null;
      currentPart = null;
      inChoice = false;
      continue;
    }

    if (INSTRUCTION_HEADER_RE.test(trimmed)) {
      inInstructions = true;
      currentTop = null;
      currentPart = null;
      inChoice = false;
      continue;
    }

    // Inside an instruction block, numbered lines are examination rules until
    // a line clearly stops sounding like one.
    if (inInstructions) {
      const numbered = trimmed.match(/^(?:\(?[ivx]+\)|\d{1,3}[.)])\s*(.+)$/i);
      const content = cleanInline(numbered ? numbered[1] : trimmed);
      if (numbered && !INSTRUCTION_LINE_RE.test(content)) {
        inInstructions = false;
      } else {
        if (content.length >= 4 && rules.length < 20) {
          rules.push(content.slice(0, 300));
          const marks = globalMarksFromRule(content);
          if (marks) globalMarks = marks;
        }
        continue;
      }
    }

    if (PAGE_NUMBER_RE.test(trimmed)) continue;

    // Table rows belong to the question that introduces them. Reading a cell
    // such as `2` as a question label would split the table into fake questions.
    if (currentTop && looksLikeDataRow(trimmed)) {
      appendText(trimmed);
      continue;
    }

    const questionMatch = questionStart(trimmed);
    // An alternative printed under `OR` often repeats the question number:
    // `4. Define reflection ... OR 4. Define refraction ...`. It is the same
    // question, not a second one, so its marks must not be counted twice.
    if (questionMatch && inChoice && currentTop && questionMatch.number === currentTop.number) {
      currentTop.choiceLines = currentTop.choiceLines ?? [];
      if (questionMatch.rest) currentTop.choiceLines.push(questionMatch.rest);
      continue;
    }
    if (questionMatch) {
      const { number, rest } = questionMatch;
      if (inChoice && currentTop && number !== currentTop.number) inChoice = false;
      const existing: Draft | undefined = tops.find(top => top.number === number);
      const emptyExisting = !!existing && existing.lines.length === 0 && existing.parts.length === 0;
      const atGroupStart = currentTop === null;
      const stepLine = !forced && !atGroupStart && !emptyExisting && number <= sectionHighest;
      // Once a numbered step is seen, its successors are steps too unless the
      // line carries its own printed marks, which a calculation step never does.
      // A question whose printed mark sits before its working has already
      // ended; the numbered lines after it are steps. When no mark is printed
      // on the question at all (a section-wide rule), the next number is a
      // real question, not a step.
      const currentHasPrintedMarks =
        !!currentTop && !atGroupStart && marksFromText(currentTop.lines) !== null;
      const continuesStep =
        !forced &&
        !atGroupStart &&
        !emptyExisting &&
        stepMode !== null &&
        currentHasPrintedMarks &&
        number === stepMode + 1 &&
        marksFromText([trimmed]) === null;
      if (stepLine || continuesStep) {
        appendText(trimmed);
        stepMode = number;
        continue;
      }
      if (emptyExisting) {
        currentTop = existing;
        currentPart = null;
        inChoice = false;
        expected = number + 1;
        if (rest) startPartOrText(existing, rest);
        continue;
      }
      const draft = startTop(number);
      if (rest) startPartOrText(draft, rest);
      continue;
    }

    const choiceMatch = trimmed.match(CHOICE_RE);
    if (choiceMatch && currentTop) {
      currentTop.choiceLines = currentTop.choiceLines ?? [];
      inChoice = true;
      currentPart = null;
      const rest = cleanInline(choiceMatch[1]);
      if (rest) currentTop.choiceLines.push(rest);
      continue;
    }

    // Inline sub-parts are recognised before option rows because both look like
    // `(a) ... (b) ...`; splitPartRun only accepts a run with per-part marks.
    if (currentTop && !inChoice && consumePartRun(currentTop, trimmed)) continue;

    // A row of options such as "(a) respiration (b) photosynthesis (c) ..." is
    // one objective question, not four sub-questions. The row itself is the
    // strongest signal: real sub-parts are written one per line.
    if (currentTop && !inChoice && looksLikeOptionRow(trimmed)) {
      currentTop.mcq = true;
      appendText(trimmed);
      currentPart = null;
      continue;
    }

    // `(a) ...` lines are sub-parts, except in a multiple-choice question where
    // they are answer options belonging to the same question.
    const part = inChoice ? null : subpartLabel(trimmed, usesRoman, currentTop?.parts ?? []);
    if (part && currentTop && !isMultipleChoice(currentTop)) {
      startPart(currentTop, part.label, cleanInline(part.rest));
      continue;
    }

    // A standalone marks line such as "(5)" belongs to the current question.
    if (/^[\[(]\s*\d{1,3}(?:\.\d+)?\s*(?:marks?|अंक)?\s*[\])]$/i.test(trimmed)) {
      appendText(trimmed);
      continue;
    }

    appendText(trimmed);
  }

  function startPartOrText(parent: Draft, rest: string) {
    if (consumePartRun(parent, rest)) return;
    const part = subpartLabel(rest, usesRoman, parent.parts);
    if (part) {
      startPart(parent, part.label, cleanInline(part.rest));
    } else {
      parent.lines.push(rest);
      currentTop = parent;
      currentPart = null;
      inChoice = false;
    }
  }

  // ---- Convert drafts into paper questions -------------------------------
  const questions: PaperQuestion[] = [];
  const byKey = new Map<string, PaperQuestion>();

  const pushQuestion = (question: PaperQuestion) => {
    const existing = byKey.get(question.key);
    if (existing) {
      warnings.push(
        `${question.ref} appears more than once in the paper. Its text was combined; check that the printed numbering is correct.`
      );
      existing.text = cleanInline(`${existing.text} ${question.text}`);
      existing.choiceText = existing.choiceText ?? question.choiceText;
      if (existing.max === null && question.max !== null) {
        existing.max = question.max;
        existing.marksSource = question.marksSource;
        existing.marksEvidence = question.marksEvidence;
      } else if (existing.max !== null && question.max !== null && existing.max !== question.max) {
        warnings.push(
          `${question.ref} prints ${question.max} marks in one place and ${existing.max} in another. ${existing.max} was kept.`
        );
      }
      return;
    }
    byKey.set(question.key, question);
    questions.push(question);
  };

  for (const draft of tops) {
    const built = finaliseDraft(draft, draft.sectionMarks, globalMarks);
    const parentValue =
      built.parentMarks?.max ?? draft.sectionMarks?.max ?? globalMarks?.max ?? null;

    if (built.parts.length) {
      const values = built.parts.map(part => part.marks?.max ?? null);
      const allocated = parentValue !== null ? allocateMarks(parentValue, values) : null;
      const partValues = allocated ?? values;

      if (allocated) {
        warnings.push(
          `${displayRef(draft.key)} prints ${parentValue} marks in total but no mark for each part, so its ${built.parts.length} parts were divided as ${partValues
            .map(value => (value === null ? '?' : Number(value.toFixed(2))))
            .join(' + ')}. Check your paper if that split is wrong.`
        );
      }

      const parentTotal =
        parentValue ??
        (partValues.every((value): value is number => value !== null)
          ? partValues.reduce((sum, value) => sum + value, 0)
          : null);

      if (built.parentMarks && built.allPartsHaveMarks && Math.abs(built.explicitSum - built.parentMarks.max) > 0.001) {
        warnings.push(
          `${displayRef(draft.key)} prints ${built.parentMarks.max} marks but its sub-parts add up to ${built.explicitSum}. The printed sub-part marks were used.`
        );
      }

      for (const [index, part] of built.parts.entries()) {
        const key = part.draft.key;
        const explicit = part.marks?.max ?? null;
        const max = partValues[index] ?? null;
        const allocatedHere = explicit === null && max !== null;
        const text = part.text;
        pushQuestion({
          key,
          ref: displayRef(key),
          parentKey: parentKeyOf(key),
          text,
          parentText: built.text || null,
          parentMax: parentTotal,
          // An internal choice printed for the whole question also applies to
          // its sub-parts when they do not carry their own alternative.
          choiceText: part.choiceText ?? built.choiceText,
          max,
          marksSource:
            max === null ? null : allocatedHere ? ('allocated' as MarksSource) : ('explicit' as MarksSource),
          marksEvidence:
            part.marks?.evidence ??
            (allocatedHere ? `${parentValue} marks printed for ${displayRef(draft.key)}, divided across its parts` : null),
          section: draft.section,
          kind: detectQuestionKind({ text: `${built.text} ${text}`, choiceText: part.choiceText, max }),
          page: part.draft.page,
          pageLine: part.draft.pageLine,
        });
      }
      continue;
    }

    const text = stripBareOptionMark(built.text, built.parentMarks);
    if (text.length < 2) continue;

    const explicit = built.parentMarks;
    const sectionValue = draft.sectionMarks ?? null;
    const globalValue = globalMarks ?? null;
    let max: number | null = null;
    let marksSource: MarksSource | null = null;
    let marksEvidence: string | null = null;

    if (explicit) {
      max = explicit.max;
      marksSource = 'explicit';
      marksEvidence = explicit.evidence;
    } else if (sectionValue) {
      max = sectionValue.max;
      marksSource = 'section';
      marksEvidence = sectionValue.evidence;
    } else if (globalValue) {
      max = globalValue.max;
      marksSource = 'instruction';
      marksEvidence = globalValue.evidence;
    }

    pushQuestion({
      key: draft.key,
      ref: displayRef(draft.key),
      parentKey: parentKeyOf(draft.key),
      text,
      choiceText: built.choiceText,
      max,
      marksSource,
      marksEvidence,
      section: draft.section,
      kind: detectQuestionKind({ text, choiceText: built.choiceText, max }),
      page: draft.page,
      pageLine: draft.pageLine,
    });
  }

  if (!questions.length && rawText.trim().length > 40) {
    warnings.push(
      'No numbered questions were detected in this document. Check that you uploaded the question paper, or type the questions manually.'
    );
  }

  const unresolvedRefs = questions.filter(question => question.max === null).map(question => question.ref);
  if (unresolvedRefs.length) {
    warnings.push(
      `The printed maximum marks could not be found for ${unresolvedRefs.slice(0, 6).join(', ')}${unresolvedRefs.length > 6 ? '…' : ''}. Confirm these marks before marking.`
    );
  }

  // A gap in the numbering is the clearest signal that a question was missed,
  // which is exactly what a merged or badly OCR'd page produces.
  const numbers = [...new Set(questions.map(question => Number(parentKeyOf(question.key))))]
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (numbers.length && numbers[0] === 1) {
    const highest = numbers[numbers.length - 1];
    const missing: number[] = [];
    for (let value = 1; value <= highest; value++) {
      if (!numbers.includes(value)) missing.push(value);
    }
    if (missing.length) {
      warnings.push(
        `Question number${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing between Q1 and Q${highest}. Paperwise did not invent them — check that the upload shows every question before marking.`
      );
    }
  }

  // Never silently present maths that the extractor could not encode.
  const garbled = questions.filter(question => /\uFFFD|\?{2,}/.test(question.text)).map(question => question.ref);
  if (garbled.length) {
    warnings.push(
      `The mathematical notation in ${garbled.slice(0, 6).join(', ')}${garbled.length > 6 ? '…' : ''} contains characters that could not be read. The extracted text was kept as it is — check that question against your paper before trusting the marks.`
    );
  }

  const resolvedTotal = Math.round(questions.reduce((sum, question) => sum + (question.max ?? 0), 0) * 100) / 100;
  const printedTotal = printedTotalFromText(rawText);
  if (printedTotal !== null && questions.length && Math.abs(printedTotal - resolvedTotal) > 0.01) {
    warnings.push(
      resolvedTotal < printedTotal
        ? `The paper states a total of ${printedTotal} marks, but only ${resolvedTotal} marks were found across its questions. Some questions or printed marks were not recognised; review the question chips before marking.`
        : `The questions add up to ${resolvedTotal} marks, which is more than the ${printedTotal} marks printed on the paper. Check for a duplicated question or sub-part.`
    );
  }

  return {
    questions,
    sections: sections.map(({ key: _key, ...section }) => section),
    rules,
    warnings,
    resolvedTotal,
    printedTotal,
    unresolvedRefs,
    source: 'upload',
  };
}

function finaliseDraft(draft: Draft, sectionMarks: MarksInfo | null, globalMarks: MarksInfo | null) {
  const choiceText = draft.choiceLines ? buildQuestionText(draft.choiceLines) || null : null;
  const own = marksFromText(draft.lines);
  const ownChoice = draft.choiceLines ? marksFromText(draft.choiceLines) : null;
  const questionText = buildQuestionText(draft.lines);

  if (draft.parts.length && partsLookLikeOptions(draft)) {
    // The "sub-parts" are really answer options: fold them back into the
    // question instead of grading four one-word options as four answers.
    const options = draft.parts
      .map(part => `(${part.label}) ${buildQuestionText(part.lines)}`)
      .join(' ');
    const marks = marksFromText([...draft.lines, ...draft.parts.flatMap(part => part.lines)]);
    return {
      text: cleanInline(`${questionText} ${options}`),
      choiceText,
      parentMarks: marks ?? own ?? ownChoice,
      parts: [] as Array<{ draft: Draft; text: string; choiceText: string | null; marks: MarksInfo | null }>,
      explicitSum: 0,
      allPartsHaveMarks: false,
      sectionMarks,
      globalMarks,
    };
  }

  if (draft.parts.length) {
    const parts = draft.parts
      .map(part => {
        const partLines = [...part.lines, ...(part.choiceLines ?? [])];
        const partMarks = marksFromText(part.lines) ?? marksFromText(partLines);
        return {
          draft: part,
          text: buildQuestionText(part.lines),
          choiceText: part.choiceLines ? buildQuestionText(part.choiceLines) || null : null,
          marks: partMarks,
        };
      })
      .filter(part => part.text.length >= 2);

    const explicitSum = parts.reduce((sum, part) => sum + (part.marks?.max ?? 0), 0);
    const allPartsHaveMarks = parts.length > 0 && parts.every(part => part.marks);

    return {
      text: questionText,
      choiceText,
      parentMarks: own ?? ownChoice,
      parts,
      explicitSum,
      allPartsHaveMarks,
      sectionMarks,
      globalMarks,
    };
  }

  return {
    text: questionText,
    choiceText,
    parentMarks: own ?? ownChoice,
    parts: [] as Array<{ draft: Draft; text: string; choiceText: string | null; marks: MarksInfo | null }>,
    explicitSum: 0,
    allPartsHaveMarks: false,
    sectionMarks,
    globalMarks,
  };
}

/**
 * Are these "parts" actually a multiple-choice option list? Options are short,
 * unmarked, consecutive `(a)…(d)` lines under a question stem. Real sub-parts
 * either carry marks or read as full instructions.
 */
function partsLookLikeOptions(draft: Draft): boolean {
  const parts = draft.parts;
  if (parts.length < 2 || parts.length > 6) return false;
  const labels = parts.map(part => part.label.toLowerCase());
  if (labels.some(label => isRoman(label))) return false;
  // Options may be wrapped over two lines, so a run can start at (c), and one
  // line can carry `(a) ... (b) ...` while the next carries `(c) ... (d) ...`.
  const codes = labels.map(label => label.charCodeAt(0) - 97);
  if (!codes.every((code, index) => index === 0 || code > codes[index - 1])) return false;
  const inlineMarkers = parts.some(part => /\([a-h]\)/i.test(buildQuestionText(part.lines)));
  if (parts.some(part => marksFromText(part.lines) !== null)) return false;
  if (parts.some(part => part.choiceLines)) return false;
  const short = parts.every(part => buildQuestionText(part.lines).length <= 90);
  if (!short) return false;
  const stem = buildQuestionText(draft.lines);
  const asksQuestion = /\?\s*$/.test(stem) || MCQs.test(stem);
  const oneMark = marksFromText(draft.lines)?.max === 1;
  return (asksQuestion && (codes[0] === 0 || inlineMarkers)) || (labels.length === 4 && codes[0] === 0 && oneMark);
}

function printedTotalFromText(rawText: string): number | null {
  const match =
    rawText.match(/(?:maximum|max\.?|total)\s*marks?\s*[:\-–—]?\s*(\d{1,4})/i) ??
    rawText.match(/पूर्णांक\s*[:\-–—]?\s*(\d{1,4})/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value <= 1000 ? value : null;
}

/** Build a paper from manually typed questions. */
export function paperFromManual(
  items: Array<{ key: string; prompt: string; marks: number; criteria?: string }>,
  boardLabel = ''
): Paper {
  const questions: PaperQuestion[] = items
    .filter(item => item.prompt.trim().length > 0)
    .map((item, index) => {
      const key = item.key || String(index + 1);
      const text = cleanInline(item.prompt);
      const max = clampMarks(item.marks);
      return {
        key,
        ref: displayRef(key),
        parentKey: parentKeyOf(key),
        text,
        choiceText: null,
        max,
        marksSource: max !== null ? ('manual' as MarksSource) : null,
        marksEvidence: null,
        section: '',
        kind: detectQuestionKind({ text, max }),
        page: null,
        markingPoints: item.criteria?.trim() ?? '',
      };
    });
  const unresolvedRefs = questions.filter(question => question.max === null).map(question => question.ref);
  return {
    questions,
    sections: [],
    rules: boardLabel ? [`Board/curriculum: ${boardLabel}`] : [],
    warnings: unresolvedRefs.length ? ['Some manually entered questions have no valid maximum marks.'] : [],
    resolvedTotal: Math.round(questions.reduce((sum, question) => sum + (question.max ?? 0), 0) * 100) / 100,
    printedTotal: null,
    unresolvedRefs,
    source: 'manual',
  };
}

/**
 * Apply student-confirmed marks to questions the paper did not resolve.
 * Only explicitly supplied values are used; nothing is invented.
 */
export function withMarksOverrides(paper: Paper, overrides: Record<string, number>): Paper {
  const questions = paper.questions.map(question => {
    const override = Number(overrides[question.key]);
    if (!Number.isFinite(override) || override <= 0) return question;
    return {
      ...question,
      max: clampMarks(override),
      marksSource: 'manual' as MarksSource,
      marksEvidence: null,
    };
  });
  return {
    ...paper,
    questions,
    resolvedTotal: Math.round(questions.reduce((sum, question) => sum + (question.max ?? 0), 0) * 100) / 100,
    unresolvedRefs: questions.filter(question => question.max === null).map(question => question.ref),
  };
}

/** Questions Paperwise can actually mark (resolved, positive maxima). */
export function gradeableQuestions(paper: Paper): PaperQuestion[] {
  return paper.questions.filter(
    (question): question is PaperQuestion & { max: number } =>
      typeof question.max === 'number' && question.max > 0
  );
}
