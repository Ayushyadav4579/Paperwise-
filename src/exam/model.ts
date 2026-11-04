/** Core Paperwise domain types shared by the parser, grader and UI. */

export type QuestionKind =
  | 'objective'
  | 'very-short'
  | 'short'
  | 'long'
  | 'numerical'
  | 'derivation'
  | 'diagram'
  | 'language';

export type MarksSource = 'explicit' | 'section' | 'instruction' | 'ai' | 'manual';

export type PaperSection = {
  name: string;
  /** Marks printed once for every question in the section, when stated. */
  marksPerQuestion: number | null;
  note: string;
};

export type PaperQuestion = {
  /** Stable matching key, e.g. `1`, `1A`, `2II`. */
  key: string;
  /** Display reference, e.g. `Q1(a)`. */
  ref: string;
  /** Parent question key (`1` for `1A`), or its own key. */
  parentKey: string;
  text: string;
  /** Alternative question text when the paper offers an internal choice. */
  choiceText: string | null;
  max: number | null;
  marksSource: MarksSource | null;
  /** Printed evidence used to resolve the maximum, when available. */
  marksEvidence: string | null;
  section: string;
  kind: QuestionKind;
  page: number | null;
  /** Optional marking points supplied by the student/teacher. */
  markingPoints?: string;
};

export type Paper = {
  questions: PaperQuestion[];
  sections: PaperSection[];
  rules: string[];
  warnings: string[];
  /** Sum of every resolved question maximum. */
  resolvedTotal: number;
  /** Refs whose maximum could not be proven from the uploaded paper. */
  unresolvedRefs: string[];
  source: 'upload' | 'manual';
};

export type AnswerSegment = {
  key: string;
  ref: string;
  text: string;
  page: number | null;
};

export type QuestionStatus = 'graded' | 'unattempted' | 'unresolved';

export type QuestionGrade = {
  key: string;
  ref: string;
  max: number;
  status: QuestionStatus;
  awarded: number;
  correctPoints: string[];
  missingPoints: string[];
  mistakes: string[];
  feedback: string;
  confidence: 'high' | 'medium' | 'low' | null;
  error: string | null;
  usedAi: boolean;
};

export type EvaluationReport = {
  /** The paper actually used, including any resolved or confirmed marks. */
  paper: Paper;
  grades: QuestionGrade[];
  /** Sum of awarded marks for graded questions. */
  awarded: number;
  /** Sum of maximum marks for graded questions. */
  gradedMax: number;
  /** Sum of all question maxima (graded + unattempted + unresolved). */
  paperTotal: number;
  gradedCount: number;
  unattemptedCount: number;
  unresolvedCount: number;
  complete: boolean;
  unmatchedAnswers: string[];
  warnings: string[];
  provider: string;
  model: string;
};

export function emptyPaper(source: Paper['source'] = 'upload'): Paper {
  return {
    questions: [],
    sections: [],
    rules: [],
    warnings: [],
    resolvedTotal: 0,
    unresolvedRefs: [],
    source,
  };
}
