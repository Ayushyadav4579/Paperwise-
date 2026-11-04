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
 */

const SECTION_RE = /^(?:section|part|भाग|खंड)\s*[-–—:]?\s*([A-Za-z0-9]{1,3})\b(.*)$/i;
const PREFIXED_QUESTION_RE = /^q(?:uestion)?\s*[.:]?\s*(\d{1,3})\s*(?:[.)\]:-]\s*|\s+)([^\d\s].*)$/i;
const NUMBERED_QUESTION_RE = /^(\d{1,3})\s*[.)\]:-]\s+([^\d\s].*)$/;
const MCQ_CUE_RE = /\b(?:choose|select|tick|which\s+of\s+the\s+following|correct\s+option|multiple\s+choice)\b/i;
const SUBPART_RE = /^\(([a-h])\)\s*(.*)$/i;
const ROMAN_SUBPART_RE = /^\((i|ii|iii|iv|v|vi|vii|viii|ix|x)\)\s*(.*)$/i;
const CHOICE_RE = /^(?:or|अथवा)\b\s*[.:;,\-–—]?\s*(.*)$/i;
const DISTRIBUTION_RE = /\b(\d{1,2})\s*[x×*]\s*(\d{1,2})\s*=\s*(\d{1,3})\b/i;
const EACH_MARKS_RE = /(?:each|every|प्रत्येक|all)\s+(?:of\s+the\s+)?(?:questions?|one\s+question)?[^.\n]{0,60}?(\d{1,3}(?:\.\d+)?)\s*(?:marks?|अंक)/i;
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
  parentTotal: number | null;
  parentEvidence: string | null;
  parts: Draft[];
};

type MarksInfo = { max: number; evidence: string };

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

function marksFromText(lines: string[]): MarksInfo | null {
  const text = cleanInline(lines.join(' '));
  if (!text) return null;

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
  return null;
}

function stripMarksMarker(text: string): string {
  return cleanInline(
    text
      .replace(TRAILING_MARKS_RE, '')
      .replace(TRAILING_DISTRIBUTION_RE, '')
      .replace(/\s*[\[(]\s*\d{1,3}(?:\.\d+)?\s*(?:marks?|अंक|m|M)?\s*[\])]\s*$/gi, ' ')
  );
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

function looksLikeOptionRow(line: string): boolean {
  const labels = [...line.matchAll(/(?:^|\s)\(([a-h])\)\s+/gi)].map(match => match[1].toLowerCase());
  if (labels.length < 3) return false;
  return new Set(labels).size >= 3;
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
  return stripMarksMarker(lines.join(' '));
}

function finaliseDraft(draft: Draft, sectionMarks: MarksInfo | null, globalMarks: MarksInfo | null) {
  const questionText = buildQuestionText(draft.lines);
  const choiceText = draft.choiceLines ? buildQuestionText(draft.choiceLines) || null : null;
  const own = marksFromText(draft.lines);
  const ownChoice = draft.choiceLines ? marksFromText(draft.choiceLines) : null;

  if (draft.parts.length) {
    const parentMarks = own ?? ownChoice;
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

    const explicitSum = parts.reduce(
      (sum, part) => sum + (part.marks?.max ?? 0),
      0
    );
    const allPartsHaveMarks = parts.length > 0 && parts.every(part => part.marks);

    return {
      text: questionText,
      choiceText,
      parentMarks,
      parts,
      explicitSum,
      allPartsHaveMarks,
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
      parentTotal: null,
      parentEvidence: null,
      parts: [],
      mcq: false,
    };
    tops.push(draft);
    currentTop = draft;
    currentPart = null;
    inChoice = false;
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
      parentTotal: null,
      parentEvidence: null,
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

  const isMultipleChoice = (draft: Draft | null): boolean =>
    !!draft && (draft.mcq || MCQ_CUE_RE.test(draft.lines.join(' ')));

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const markerPage = pageNumberFromMarker(trimmed);
    if (markerPage !== null) {
      page = markerPage;
      continue;
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
      // A new section always begins a new question group.
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

    const prefixed = trimmed.match(PREFIXED_QUESTION_RE);
    const numberedQuestion = prefixed ? null : trimmed.match(NUMBERED_QUESTION_RE);
    const questionMatch = prefixed ?? numberedQuestion;
    if (questionMatch) {
      const number = Number(questionMatch[1]);
      const rest = cleanInline(questionMatch[2] ?? '');
      const existing = tops.find(top => top.number === number);
      if (existing && existing.lines.length === 0 && existing.parts.length === 0) {
        currentTop = existing;
        currentPart = null;
        inChoice = false;
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

    if (built.parts.length) {
      const parentTotal = built.parentMarks?.max ?? null;
      if (parentTotal !== null && built.allPartsHaveMarks && Math.abs(built.explicitSum - parentTotal) > 0.001) {
        warnings.push(
          `${displayRef(draft.key)} prints ${parentTotal} marks but its sub-parts add up to ${built.explicitSum}. The printed sub-part marks were used.`
        );
      }
      for (const part of built.parts) {
        const key = part.draft.key;
        const max = part.marks?.max ?? null;
        pushQuestion({
          key,
          ref: displayRef(key),
          parentKey: parentKeyOf(key),
          text: part.text,
          // An internal choice printed for the whole question also applies to
          // its sub-parts when they do not carry their own alternative.
          choiceText: part.choiceText ?? built.choiceText,
          max,
          marksSource: max !== null ? 'explicit' : null,
          marksEvidence: part.marks?.evidence ?? null,
          section: draft.section,
          kind: detectQuestionKind({ text: part.text, choiceText: part.choiceText, max }),
          page: part.draft.page,
        });
      }
      continue;
    }

    const text = built.text;
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
  return {
    questions,
    sections: sections.map(({ key: _key, ...section }) => section),
    rules,
    warnings,
    resolvedTotal: questions.reduce((sum, question) => sum + (question.max ?? 0), 0),
    unresolvedRefs,
    source: 'upload',
  };
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
    resolvedTotal: questions.reduce((sum, question) => sum + (question.max ?? 0), 0),
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
    resolvedTotal: questions.reduce((sum, question) => sum + (question.max ?? 0), 0),
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
