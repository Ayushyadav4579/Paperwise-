import type { QuestionKind } from './model';

/** Collapse runs of whitespace inside a single logical line. */
export function cleanInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Convert any printed question reference into a stable matching key.
 * `Q1(a)`, `1. (a)`, `1(a)` and `1A` all become `1A`.
 */
export function refKey(value: string): string {
  const cleaned = value
    .toUpperCase()
    // Remove separators and brackets first so "Q1(a)" becomes "Q1A".
    .replace(/[^0-9A-Z()]/g, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    // Then drop a leading label. The lookahead keeps "Q" in a bare label but
    // strips it when it is attached to a question number.
    .replace(/^(?:QUESTION|QUES|ANS|ANSWER|NO|Q)(?=\d)/, '');
  const match = cleaned.match(/^(\d{1,3})([A-Z]{1,4})?$/);
  if (match) return `${Number(match[1])}${match[2] ?? ''}`;
  return cleaned;
}

export function parentKeyOf(key: string): string {
  const match = key.match(/^(\d{1,3})/);
  return match ? String(Number(match[1])) : key;
}

/** Turn a matching key back into a readable label such as `Q1(a)`. */
export function displayRef(key: string): string {
  const match = key.match(/^(\d{1,3})([A-Z]{1,4})?$/);
  if (!match) return key;
  const number = match[1];
  const suffix = match[2];
  if (!suffix) return `Q${number}`;
  if (suffix.length > 1) return `Q${number}(${suffix.toLowerCase()})`;
  return `Q${number}(${suffix.toLowerCase()})`;
}

/** Normalise text for verbatim-evidence checks (quotes from the model). */
export function normaliseForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u00ab\u00bb"']/g, '')
    .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `quote` appears verbatim in `source` after normalisation. Used to
 * verify model-supplied evidence before trusting it (printed marks, answers).
 */
export function containsVerbatim(source: string, quote: string): boolean {
  const needle = normaliseForMatch(quote);
  if (needle.length < 3) return false;
  return normaliseForMatch(source).includes(needle);
}

const NUMERICAL_RE =
  /\b(?:calculate|compute|solve|evaluate|find\s+(?:the\s+)?(?:value|magnitude|area|volume|velocity|speed|force|current|resistance|ratio|number|roots?|sum|product|length|height|distance|mass|pressure|energy|work|power|percentage|probability)|how\s+(?:much|many|far|long)|prove\s+that\s+.*=)/i;
const DERIVATION_RE = /\b(?:derive|derivation|obtain\s+the\s+expression|show\s+that|establish\s+the\s+(?:relation|formula))/i;
const DIAGRAM_RE = /\b(?:draw|diagram|label|sketch|graph|ray\s+diagram|circuit\s+diagram|flow\s+chart)/i;
const OBJECTIVE_RE =
  /\b(?:choose\s+the\s+correct\s+option|multiple\s+choice|tick\s+the\s+correct|fill\s+in\s+the\s+blanks?|true\s+or\s+false|match\s+the\s+(?:following|columns)|one[- ]word|correct\s+option)\b/i;
const LANGUAGE_RE =
  /\b(?:the\s+(?:poet|author|narrator|speaker|character)|central\s+idea|theme\s+of|summary\s+of\s+the\s+(?:poem|story|chapter)|figure\s+of\s+speech|why\s+did\s+the\s+(?:poet|author|narrator))\b/i;
const MCQ_OPTION_RE = /(?:^|\n|\s)\(?[a-dA-D]\)\s+\S/;

export type KindInput = { text: string; choiceText?: string | null; max?: number | null };

/**
 * Classify what kind of response a question expects. The grading prompt uses
 * this to apply subject-appropriate criteria instead of one generic rubric.
 */
export function detectQuestionKind(question: KindInput): QuestionKind {
  const text = `${question.text} ${question.choiceText ?? ''}`.replace(/\s+/g, ' ').trim();
  const marks = typeof question.max === 'number' && question.max > 0 ? question.max : null;

  if (OBJECTIVE_RE.test(text)) return 'objective';
  if (MCQ_OPTION_RE.test(question.text) && (marks ?? 0) <= 2) return 'objective';
  if (NUMERICAL_RE.test(text)) return 'numerical';
  if (DERIVATION_RE.test(text)) return 'derivation';
  if (DIAGRAM_RE.test(text) && (marks ?? 0) >= 2) return 'diagram';
  if (LANGUAGE_RE.test(text)) return 'language';
  if (marks !== null && marks <= 1) return 'very-short';
  if (marks !== null && marks <= 3) return 'short';
  return 'long';
}

/** Split text into lines while keeping empty lines as boundaries. */
export function toLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

const ROMAN_VALUES: Array<[string, number]> = [
  ['x', 10],
  ['ix', 9],
  ['viii', 8],
  ['vii', 7],
  ['vi', 6],
  ['v', 5],
  ['iv', 4],
  ['iii', 3],
  ['ii', 2],
  ['i', 1],
];

export function isRoman(label: string): boolean {
  const value = label.toLowerCase();
  return ROMAN_VALUES.some(([roman]) => roman === value);
}

export function romanValue(label: string): number {
  const value = label.toLowerCase();
  return ROMAN_VALUES.find(([roman]) => roman === value)?.[1] ?? 0;
}
