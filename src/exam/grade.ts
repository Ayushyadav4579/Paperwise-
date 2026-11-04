import { AiError, isAiError } from '../ai/errors';
import { extractJsonObject, isRecord, readConfidence, readNumber, readText, readTextList } from '../ai/json';
import type { ChatFn } from '../ai/provider';
import { PRIMARY_MODEL, PROVIDER_LABEL } from '../ai/provider';
import { segmentAnswers } from './answers';
import type { EvaluationReport, Paper, PaperQuestion, QuestionGrade } from './model';
import { withMarksOverrides, gradeableQuestions } from './paper';
import {
  buildGradingMessages,
  buildLocateMessages,
  buildMarksMessages,
  repairMessage,
  type GradingContext,
  type GradingItem,
} from './prompt';
import { containsVerbatim, normaliseForMatch, refKey } from './text';

export const MAX_QUESTIONS_PER_RUN = 60;
const BATCH_SIZE = 4;
const DEFAULT_CONCURRENCY = 3;
const MAX_LOCATE_CHUNKS = 6;

export class MarksUnresolvedError extends Error {
  readonly questions: PaperQuestion[];

  constructor(questions: PaperQuestion[]) {
    super(
      `Paperwise could not prove the maximum marks for ${questions.map(question => question.ref).join(', ')} from the uploaded paper.`
    );
    this.name = 'MarksUnresolvedError';
    this.questions = questions;
  }
}

export type EvaluateOptions = {
  paper: Paper;
  answerText: string;
  board: string;
  grade: string;
  chat: ChatFn;
  /** Raw question-paper text, used to verify printed marks. */
  paperText?: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  concurrency?: number;
  /** Set false to skip AI help for marks the parser could not find. */
  resolveMarks?: boolean;
};

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new AiError('Marking was cancelled.', 'cancelled');
}

function roundToHalf(value: number, max: number): number {
  const rounded = Math.round(value * 2) / 2;
  return Math.min(max, Math.max(0, rounded));
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function infrastructureFailure(error: unknown): boolean {
  if (!isAiError(error)) return false;
  return ['cancelled', 'auth', 'unavailable', 'network', 'rate_limit', 'timeout', 'provider'].includes(error.code);
}

function parseGradingReply(text: string, items: GradingItem[]): QuestionGrade[] {
  const parsed = extractJsonObject(text);
  const rawResults = parsed.results;
  if (!Array.isArray(rawResults)) {
    throw new AiError('The AI reply did not contain a results array.', 'invalid_output');
  }
  const byKey = new Map<string, Record<string, unknown>>();
  for (const raw of rawResults) {
    if (!isRecord(raw)) throw new AiError('The AI reply contained an invalid result.', 'invalid_output');
    const refValue = raw.ref ?? raw.id ?? raw.question;
    const key = refKey(String(refValue ?? ''));
    if (!key) throw new AiError('The AI reply contained a result with no question reference.', 'invalid_output');
    if (byKey.has(key)) throw new AiError('The AI reply repeated the same question.', 'invalid_output');
    byKey.set(key, raw);
  }

  const expectedKeys = new Set(items.map(item => item.question.key));
  for (const key of byKey.keys()) {
    if (!expectedKeys.has(key)) {
      throw new AiError('The AI returned a result for a question it was not asked to mark.', 'invalid_output');
    }
  }

  return items.map(item => {
    const raw = byKey.get(item.question.key);
    if (!raw) {
      throw new AiError('The AI omitted one of the answers it was asked to mark.', 'invalid_output');
    }
    const max = Number(item.question.max);
    const awarded = readNumber(raw.awarded ?? raw.score ?? raw.marks);
    if (awarded === null) {
      throw new AiError('The AI returned a non-numeric mark.', 'invalid_output');
    }
    // Out-of-range marks are a failed response, not something to "fix" silently.
    if (awarded < -0.001 || awarded > max + 0.001) {
      throw new AiError('The AI returned a mark outside the printed maximum.', 'invalid_output');
    }
    const feedback = readText(raw.feedback ?? raw.rationale ?? raw.explanation, 700);
    if (feedback.length < 8) {
      throw new AiError('The AI returned a mark without an explanation.', 'invalid_output');
    }
    return {
      key: item.question.key,
      ref: item.question.ref,
      max,
      status: 'graded',
      awarded: roundToHalf(awarded, max),
      correctPoints: readTextList(raw.correct_points ?? raw.correct ?? raw.matched),
      missingPoints: readTextList(raw.missing_points ?? raw.missing),
      mistakes: readTextList(raw.mistakes ?? raw.incorrect ?? raw.errors),
      feedback,
      confidence: readConfidence(raw.confidence),
      error: null,
      usedAi: true,
    };
  });
}

function unresolvedGrade(item: GradingItem, message: string): QuestionGrade {
  return {
    key: item.question.key,
    ref: item.question.ref,
    max: Number(item.question.max),
    status: 'unresolved',
    awarded: 0,
    correctPoints: [],
    missingPoints: [],
    mistakes: [],
    feedback: 'This answer could not be marked automatically. It was not counted as zero.',
    confidence: null,
    error: message,
    usedAi: false,
  };
}

async function gradeSingle(
  item: GradingItem,
  context: GradingContext,
  chat: ChatFn,
  signal?: AbortSignal
): Promise<QuestionGrade> {
  const base = buildGradingMessages([item], context);
  let lastError: unknown = null;
  let previousWasTruncated = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    checkCancelled(signal);
    try {
      // A truncated reply is not malformed, so re-asking with a higher output
      // budget is the right retry; a malformed reply gets a repair instruction.
      const messages = previousWasTruncated ? base : attempt === 0 ? base : [...base, repairMessage()];
      const result = await chat(messages, {
        maxTokens: attempt === 0 ? 900 : 1800,
        temperature: attempt === 0 ? 0.1 : 0,
        signal,
      });
      if (result.finishReason === 'length' || result.finishReason === 'max_tokens') {
        lastError = new AiError('The AI reply hit its output limit.', 'length');
        previousWasTruncated = true;
        continue;
      }
      const [grade] = parseGradingReply(result.text, [item]);
      return grade;
    } catch (error) {
      if (infrastructureFailure(error)) throw error;
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : 'the AI response could not be verified';
  return unresolvedGrade(item, detail);
}

async function gradeBatch(
  items: GradingItem[],
  context: GradingContext,
  chat: ChatFn,
  signal?: AbortSignal
): Promise<QuestionGrade[]> {
  checkCancelled(signal);
  if (items.length === 0) return [];
  if (items.length === 1) return [await gradeSingle(items[0], context, chat, signal)];

  try {
    const result = await chat(buildGradingMessages(items, context), {
      maxTokens: 260 * items.length + 500,
      temperature: 0.1,
      signal,
    });
    if (result.finishReason === 'length' || result.finishReason === 'max_tokens') {
      throw new AiError('The AI reply hit its output limit.', 'length');
    }
    return parseGradingReply(result.text, items);
  } catch (error) {
    if (infrastructureFailure(error)) throw error;
    // A batch failure is usually a truncated or malformed reply. Split it and
    // mark each question on its own; never discard the whole paper for one
    // unparseable batch.
    const midpoint = Math.ceil(items.length / 2);
    const [left, right] = await Promise.all([
      gradeBatch(items.slice(0, midpoint), context, chat, signal),
      gradeBatch(items.slice(midpoint), context, chat, signal),
    ]);
    return [...left, ...right];
  }
}

/**
 * Find the character index where a verbatim quote begins. Whitespace and
 * punctuation may differ slightly because OCR and the model both normalise
 * them, but the words must appear in order.
 */
export function findQuoteIndex(source: string, quote: string): number {
  const words = normaliseForMatch(quote)
    .split(' ')
    .filter(word => word.length >= 2)
    .slice(0, 12);
  if (!words.length) return -1;
  const escaped = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('[\\s\\S]{0,24}?'), 'i');
  const match = pattern.exec(source);
  return match ? match.index : -1;
}

/**
 * Cut one answer out of the answer sheet, starting at a verified quote and
 * ending at the next question reference. The model only supplies the anchor,
 * so the answer text itself is never model-generated.
 */
export function extractAnswerAt(source: string, startIndex: number, key: string): string {
  const tail = source.slice(startIndex);
  const lines = tail.split('\n');
  const collected: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (index > 0) {
      const refMatch = line.match(/^\s*(?:q(?:uestion)?|ans(?:wer)?)?\s*\.?\s*(\d{1,3})\s*[.)\]:-]\s+/i);
      if (refMatch && refKey(refMatch[1]) !== key) break;
    }
    collected.push(line);
    if (collected.join('\n').length > 3500) break;
  }
  return collected.join('\n').trim();
}

function locateChunks(answerText: string): string[] {
  if (answerText.length <= 9000) return [answerText];
  const lines = answerText.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > 7000 && current.length) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
    if (chunks.length >= MAX_LOCATE_CHUNKS) break;
  }
  if (current.length && chunks.length < MAX_LOCATE_CHUNKS) chunks.push(current.join('\n'));
  return chunks;
}

async function locateUnlabelledAnswers(input: {
  missing: PaperQuestion[];
  answerText: string;
  chat: ChatFn;
  signal?: AbortSignal;
  onProgress: (message: string) => void;
}): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const pending = [...input.missing];
  const chunks = locateChunks(input.answerText);

  for (const chunk of chunks) {
    if (!pending.length) break;
    checkCancelled(input.signal);
    input.onProgress('Looking for answers that were not numbered clearly…');
    let parsed: Record<string, unknown>;
    try {
      const result = await input.chat(buildLocateMessages({ missing: pending.slice(0, 6).map(question => ({ ref: question.ref, text: question.text })), excerpt: chunk }), {
        maxTokens: 500,
        temperature: 0,
        signal: input.signal,
      });
      parsed = extractJsonObject(result.text);
    } catch (error) {
      if (infrastructureFailure(error)) throw error;
      // Location is a convenience fallback; failing it must not fail marking.
      continue;
    }
    const entries = Array.isArray(parsed.found) ? parsed.found : [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const key = refKey(String(entry.ref ?? ''));
      const quote = readText(entry.start_quote, 400);
      const question = pending.find(item => item.key === key);
      if (!question || !quote) continue;
      const index = findQuoteIndex(chunk, quote);
      if (index < 0) continue;
      const answer = extractAnswerAt(chunk, index, key);
      if (answer.trim().length < 20) continue;
      found.set(key, answer);
      pending.splice(pending.indexOf(question), 1);
    }
  }
  return found;
}

export type MarksResolution = {
  paper: Paper;
  notes: string[];
  verifiedCount: number;
};

/**
 * Ask the model for maxima the parser could not find. Every answer must quote
 * printed evidence that exists verbatim in the paper; unverified claims are
 * discarded, so a mark is never invented.
 */
export async function resolvePaperMarks(input: {
  paper: Paper;
  paperText: string;
  board: string;
  grade: string;
  chat: ChatFn;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<MarksResolution> {
  const unresolved = input.paper.questions.filter(question => question.max === null);
  if (!unresolved.length) return { paper: input.paper, notes: [], verifiedCount: 0 };
  if (!input.paperText.trim()) return { paper: input.paper, notes: [], verifiedCount: 0 };

  input.onProgress?.('Looking for printed maximum marks…');
  const messages = buildMarksMessages({
    questions: unresolved.map(question => ({
      ref: question.ref,
      text: question.text,
      section: question.section,
    })),
    paperText: input.paperText,
    board: input.board,
    grade: input.grade,
  });

  let parsed: Record<string, unknown>;
  try {
    const result = await input.chat(messages, { maxTokens: 900, temperature: 0, signal: input.signal });
    parsed = extractJsonObject(result.text);
  } catch (error) {
    if (infrastructureFailure(error)) throw error;
    return { paper: input.paper, notes: ['Printed marks could not be recovered automatically.'], verifiedCount: 0 };
  }

  const notes: string[] = [];
  const verified = new Map<string, { max: number; evidence: string }>();
  const entries = Array.isArray(parsed.marks) ? parsed.marks : [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const key = refKey(String(entry.ref ?? ''));
    const question = unresolved.find(item => item.key === key);
    if (!question) continue;
    const max = readNumber(entry.max);
    const evidence = readText(entry.evidence, 200);
    if (max === null || max <= 0 || max > 100) {
      notes.push(`${question.ref}: the suggested maximum was not a valid mark.`);
      continue;
    }
    if (!evidence || !containsVerbatim(input.paperText, evidence)) {
      notes.push(`${question.ref}: the cited printed marks could not be found in the paper, so they were not used.`);
      continue;
    }
    verified.set(key, { max, evidence });
  }

  const overrides: Record<string, number> = {};
  for (const [key, value] of verified) overrides[key] = value.max;
  let next = withMarksOverrides(input.paper, overrides);
  next = {
    ...next,
    questions: next.questions.map(question => {
      const value = verified.get(question.key);
      if (!value) return question;
      return { ...question, marksSource: 'ai' as const, marksEvidence: value.evidence };
    }),
  };

  return { paper: next, notes, verifiedCount: verified.size };
}

/**
 * Mark a complete paper. Every score is produced by the model against the
 * question text and verified before it is used; questions with no answer are
 * recorded as unattempted rather than silently dropped.
 */
export async function evaluatePaper(options: EvaluateOptions): Promise<EvaluationReport> {
  const progress = options.onProgress ?? (() => undefined);
  const { chat, signal } = options;
  checkCancelled(signal);

  let paper = options.paper;
  if (paper.unresolvedRefs.length && options.resolveMarks !== false && options.paperText?.trim()) {
    const resolution = await resolvePaperMarks({
      paper,
      paperText: options.paperText,
      board: options.board,
      grade: options.grade,
      chat,
      signal,
      onProgress: progress,
    });
    paper = resolution.paper;
  }

  if (paper.unresolvedRefs.length) {
    throw new MarksUnresolvedError(paper.questions.filter(question => question.max === null));
  }

  const questions = gradeableQuestions(paper);
  if (!questions.length) {
    throw new Error('No questions with a printed maximum mark were found. Upload a clearer question paper or add questions manually.');
  }
  if (questions.length > MAX_QUESTIONS_PER_RUN) {
    throw new Error(
      `This paper has ${questions.length} questions; Paperwise marks up to ${MAX_QUESTIONS_PER_RUN} at a time. Split it into parts.`
    );
  }

  const warnings: string[] = [];
  progress('Matching your answers to the paper…');
  const segmentation = segmentAnswers(options.answerText, paper);
  warnings.push(...segmentation.warnings);

  const answers = new Map<string, string>();
  for (const segment of segmentation.segments) {
    if (segment.text.trim()) answers.set(segment.key, segment.text);
  }

  let missing = questions.filter(question => !answers.has(question.key));
  const shouldLocate =
    missing.length > 0 &&
    options.answerText.trim().length > 60 &&
    (segmentation.detectedRefs === 0 || missing.length >= Math.max(2, Math.ceil(questions.length * 0.4)));
  if (shouldLocate) {
    const located = await locateUnlabelledAnswers({
      missing,
      answerText: options.answerText,
      chat,
      signal,
      onProgress: progress,
    });
    for (const [key, value] of located) answers.set(key, value);
    if (located.size) {
      warnings.push(
        `${located.size} answer${located.size > 1 ? 's were' : ' was'} matched by content because the answer sheet did not label ${located.size > 1 ? 'them' : 'it'} clearly.`
      );
    }
    missing = questions.filter(question => !answers.has(question.key));
  }

  const items: GradingItem[] = questions
    .filter(question => answers.has(question.key))
    .map(question => ({ question, answer: (answers.get(question.key) ?? '').trim() }))
    .filter(item => item.answer.length > 0);

  const context: GradingContext = {
    board: options.board,
    grade: options.grade,
    rules: paper.rules,
    sections: paper.sections,
  };

  const batches: GradingItem[][] = [];
  for (let index = 0; index < items.length; index += BATCH_SIZE) {
    batches.push(items.slice(index, index + BATCH_SIZE));
  }

  let completed = 0;
  progress(items.length ? `Marking ${items.length} answers…` : 'No written answers were found.');
  const graded = await mapLimit(batches, options.concurrency ?? DEFAULT_CONCURRENCY, async batch => {
    const result = await gradeBatch(batch, context, chat, signal);
    completed += batch.length;
    progress(`Marked ${completed} of ${items.length} answers…`);
    return result;
  });

  const grades: QuestionGrade[] = graded.flat();
  for (const question of missing) {
    const answeredElsewhere = answers.get(question.key);
    if (answeredElsewhere && answeredElsewhere.trim()) continue;
    grades.push({
      key: question.key,
      ref: question.ref,
      max: Number(question.max),
      status: 'unattempted',
      awarded: 0,
      correctPoints: [],
      missingPoints: [],
      mistakes: [],
      feedback: 'No answer was found for this question, so it was marked as not attempted.',
      confidence: null,
      error: null,
      usedAi: false,
    });
  }

  const report = buildReport({
    grades,
    paper,
    provider: PROVIDER_LABEL,
    model: PRIMARY_MODEL,
    warnings,
  });
  validateReport(report);
  return report;
}

export function buildReport(input: {
  grades: QuestionGrade[];
  paper: Paper;
  provider: string;
  model: string;
  warnings?: string[];
}): EvaluationReport {
  const order = new Map(input.paper.questions.map((question, index) => [question.key, index]));
  const grades = [...input.grades].sort(
    (left, right) => (order.get(left.key) ?? 999) - (order.get(right.key) ?? 999)
  );

  const graded = grades.filter(grade => grade.status === 'graded');
  const unattempted = grades.filter(grade => grade.status === 'unattempted');
  const unresolved = grades.filter(grade => grade.status === 'unresolved');
  const paperTotal = input.paper.questions.reduce((sum, question) => sum + (question.max ?? 0), 0);

  return {
    paper: input.paper,
    grades,
    awarded: Math.round(graded.reduce((sum, grade) => sum + grade.awarded, 0) * 100) / 100,
    gradedMax: Math.round(graded.reduce((sum, grade) => sum + grade.max, 0) * 100) / 100,
    paperTotal: Math.round(paperTotal * 100) / 100,
    gradedCount: graded.length,
    unattemptedCount: unattempted.length,
    unresolvedCount: unresolved.length,
    complete: unresolved.length === 0,
    unmatchedAnswers: [],
    warnings: input.warnings ?? [],
    provider: input.provider,
    model: input.model,
  };
}

/** Throw if the report is internally inconsistent. Used in tests and at runtime. */
export function validateReport(report: EvaluationReport): void {
  for (const grade of report.grades) {
    if (!Number.isFinite(grade.awarded) || grade.awarded < 0) {
      throw new Error(`Invalid awarded mark for ${grade.ref}.`);
    }
    if (grade.awarded > grade.max + 0.001) {
      throw new Error(`Awarded mark for ${grade.ref} exceeds its maximum of ${grade.max}.`);
    }
    if (grade.status === 'graded' && grade.feedback.trim().length < 8) {
      throw new Error(`Graded question ${grade.ref} has no explanation.`);
    }
  }
  const sum = report.grades
    .filter(grade => grade.status === 'graded')
    .reduce((total, grade) => total + grade.awarded, 0);
  if (Math.abs(sum - report.awarded) > 0.01) {
    throw new Error('Report total does not equal the sum of question-wise marks.');
  }
  const maxSum = report.grades
    .filter(grade => grade.status === 'graded')
    .reduce((total, grade) => total + grade.max, 0);
  if (Math.abs(maxSum - report.gradedMax) > 0.01) {
    throw new Error('Report maximum does not equal the sum of graded question maxima.');
  }
  if (report.paperTotal + 0.01 < report.gradedMax) {
    throw new Error('Graded maximum exceeds the paper total.');
  }
  if (report.complete && report.awarded > report.paperTotal + 0.01) {
    throw new Error('Total score exceeds the paper total.');
  }
  if (report.grades.length !== report.gradedCount + report.unattemptedCount + report.unresolvedCount) {
    throw new Error('Report question counts are inconsistent.');
  }
  if (report.grades.length !== report.paper.questions.length) {
    throw new Error('Report does not contain exactly one line per paper question.');
  }
}

