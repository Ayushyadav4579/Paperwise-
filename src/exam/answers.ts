import type { AnswerSegment, Paper } from './model';
import { cleanInline, displayRef, isRoman, refKey, toLines } from './text';
import { pageNumberFromMarker } from '../extraction/layout';

/**
 * Deterministic answer-sheet segmentation.
 *
 * Students may answer out of order, skip questions, continue an answer on a
 * later page, or label answers loosely (`Q3`, `Ans 3`, `3.`). References are
 * matched against the question paper that was actually uploaded, which avoids
 * treating a line like "2.5 moles of gas" as question 2.
 */

const PREFIXED_REF_RE =
  /^(?:ans(?:wer)?|sol(?:ution)?|q(?:uestion)?)\s*\.?\s*[-:.)]?\s*(\d{1,3})\s*(?:[.)\]:-]\s*|\s+)(.*)$/i;
const NUMBERED_REF_RE = /^(\d{1,3})\s*[.)\]:-]\s+(.*)$/;
const SUBPART_REF_RE = /^\(([a-h])\)\s*(.*)$/i;
const ROMAN_REF_RE = /^\((i|ii|iii|iv|v|vi|vii|viii|ix|x)\)\s*(.*)$/i;
const REF_INSIDE_LINE_RE = /^\s*(\d{1,3})\s*\(([a-h]|[ivx]{1,4})\)\s*(.*)$/i;

export type Segmentation = {
  segments: AnswerSegment[];
  /** Text before the first detectable answer reference. */
  preamble: string;
  detectedRefs: number;
  warnings: string[];
};

type Working = {
  key: string;
  ref: string;
  page: number | null;
  lines: string[];
};

function mergeWorking(items: Working[]): AnswerSegment[] {
  const order: string[] = [];
  const map = new Map<string, Working>();
  for (const item of items) {
    const existing = map.get(item.key);
    if (!existing) {
      map.set(item.key, { ...item, lines: [...item.lines] });
      order.push(item.key);
      continue;
    }
    existing.lines.push(...item.lines);
    existing.page = existing.page ?? item.page;
  }
  return order.map(key => {
    const item = map.get(key)!;
    return {
      key,
      ref: displayRef(key),
      text: item.lines.join('\n').replace(/[ \t]+/g, ' ').trim(),
      page: item.page,
    };
  });
}

export function segmentAnswers(text: string, paper?: Paper | null): Segmentation {
  const warnings: string[] = [];
  const questionKeys = new Set(paper?.questions.map(question => question.key) ?? []);
  const parentKeys = new Set(paper?.questions.map(question => question.parentKey) ?? []);
  const hasPaper = !!paper && questionKeys.size > 0;
  const usesRoman = /\((?:ii|iii|iv|vi|vii|viii|ix)\)/i.test(text);

  const working: Working[] = [];
  let current: Working | null = null;
  let currentParent: string | null = null;
  let page: number | null = null;
  let preamble = '';
  let detectedRefs = 0;

  const accepts = (key: string): boolean => {
    if (!hasPaper) return true;
    return questionKeys.has(key) || parentKeys.has(key);
  };

  const flushPreamble = (line: string) => {
    preamble = preamble ? `${preamble}\n${line}` : line;
  };

  const startSegment = (key: string, refText: string, rest: string) => {
    const segment: Working = { key, ref: refText, page, lines: rest ? [rest] : [] };
    working.push(segment);
    current = segment;
    detectedRefs++;
  };

  for (const rawLine of toLines(text)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const markerPage = pageNumberFromMarker(trimmed);
    if (markerPage !== null) {
      page = markerPage;
      continue;
    }

    const prefixed = trimmed.match(PREFIXED_REF_RE);
    const numbered = prefixed ? null : trimmed.match(NUMBERED_REF_RE);
    const match = prefixed ?? numbered;
    if (match) {
      const key = refKey(match[1]);
      const rest = cleanInline(match[2] ?? '');
      if (accepts(key)) {
        // "1. (a) ..." answers the sub-part directly rather than the parent.
        const inlinePart = rest.match(SUBPART_REF_RE) ?? (usesRoman ? rest.match(ROMAN_REF_RE) : null);
        if (inlinePart) {
          const subKey = refKey(`${key}${inlinePart[1].toUpperCase()}`);
          if (questionKeys.has(subKey)) {
            currentParent = key;
            startSegment(subKey, displayRef(subKey), cleanInline(inlinePart[2] ?? ''));
            continue;
          }
        }
        currentParent = key;
        startSegment(key, displayRef(key), rest);
        continue;
      }
      // A number that is not a question in the uploaded paper is answer text
      // (for example a numbered step inside a solution).
      if (current) current.lines.push(trimmed);
      else flushPreamble(trimmed);
      continue;
    }

    // References written inline, e.g. "1(a) Explain ..." or "2(iii) ...".
    const inline = trimmed.match(REF_INSIDE_LINE_RE);
    if (inline) {
      const label = inline[2].toLowerCase();
      const key = refKey(`${inline[1]}${label.toUpperCase()}`);
      if (accepts(key) && (hasPaper || isRoman(label) || /^[a-h]$/i.test(label))) {
        currentParent = refKey(inline[1]);
        startSegment(key, displayRef(key), cleanInline(inline[3] ?? ''));
        continue;
      }
    }

    const roman = usesRoman ? trimmed.match(ROMAN_REF_RE) : null;
    const letter = trimmed.match(SUBPART_REF_RE);
    const subpart = roman ?? letter;
    if (subpart && currentParent) {
      const label = subpart[1].toLowerCase();
      const subKey = refKey(`${currentParent}${label.toUpperCase()}`);
      if (questionKeys.has(subKey)) {
        startSegment(subKey, displayRef(subKey), cleanInline(subpart[2] ?? ''));
        continue;
      }
      // The paper numbers the whole question (Q3) but the student split it
      // into parts. Keep the text under the parent question.
      if (parentKeys.has(currentParent)) {
        const parentSegment = working.find(item => item.key === currentParent);
        if (parentSegment) {
          current = parentSegment;
          const rest = cleanInline(subpart[2] ?? '');
          if (rest) parentSegment.lines.push(`(${label}) ${rest}`);
          continue;
        }
      }
    }

    if (current) {
      (current as Working).lines.push(trimmed);
    } else {
      flushPreamble(trimmed);
    }
  }

  const segments = mergeWorking(working);

  if (!hasPaper && detectedRefs === 0 && text.trim().length > 40) {
    warnings.push('No question numbers were detected in this answer sheet.');
  }
  if (hasPaper && detectedRefs === 0 && text.trim().length > 40) {
    warnings.push(
      'No answer references such as “Q1” or “1.” were detected. Paperwise will try to locate each answer from its content.'
    );
  }

  return { segments, preamble: preamble.trim(), detectedRefs, warnings };
}
