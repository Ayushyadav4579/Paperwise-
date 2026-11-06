import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  FileText,
  Image,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Sparkles,
  ClipboardCheck,
  X,
  Plus,
  ArrowRight,
  ShieldCheck,
  SlidersHorizontal,
  Loader2,
  RefreshCw,
  Wifi,
} from 'lucide-react';
import { extractDocument } from './fileText';
import {
  MAX_QUESTIONS_PER_RUN,
  MarksUnresolvedError,
  evaluatePaper,
  retryUnresolvedQuestions,
} from './exam/grade';
import { paperFromManual, parsePaper, withMarksOverrides } from './exam/paper';
import type { EvaluationReport, Paper, QuestionGrade } from './exam/model';
import { createPuterChat } from './ai/provider';
import { friendlyAiMessage } from './ai/errors';

type ManualQuestion = {
  id: number;
  prompt: string;
  answer: string;
  marks: number;
  criteria: string;
};

type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  extracting: boolean;
  extractedText: string;
  warnings: string[];
  error: string | null;
  pageCount: number;
};

const initialQuestions: ManualQuestion[] = [{ id: 1, prompt: '', answer: '', marks: 3, criteria: '' }];

const STATUS_LABEL: Record<QuestionGrade['status'], string> = {
  graded: 'Marked',
  unattempted: 'Not attempted',
  unresolved: 'Needs review',
};

function formatMarks(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function paperSummaryLabel(paper: Paper): string {
  const count = paper.questions.length;
  return `${count} question${count === 1 ? '' : 's'} detected`;
}

function App() {
  const [board, setBoard] = useState('Any board');
  const [grade, setGrade] = useState('Any class');
  const [manual, setManual] = useState<ManualQuestion[]>(initialQuestions);
  const [questionFiles, setQuestionFiles] = useState<Attachment[]>([]);
  const [answerFiles, setAnswerFiles] = useState<Attachment[]>([]);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [aiCheck, setAiCheck] = useState<{ state: 'idle' | 'checking' | 'ok' | 'error'; message: string }>({
    state: 'idle',
    message: '',
  });
  const abortRef = useRef<AbortController | null>(null);
  // `busy` only updates after a render, so a double click could start two
  // expensive runs. This ref blocks the second one synchronously.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  function elapsedLabel(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  }

  function answersForMarking(usingUpload: boolean): string {
    return usingUpload
      ? answerSheetText
      : filledManual.map((question, index) => `${index + 1}. ${question.answer}`).join('\n\n');
  }

  const questionPaperText = useMemo(
    () => questionFiles.map(file => file.extractedText).filter(Boolean).join('\n\n'),
    [questionFiles]
  );
  const answerSheetText = useMemo(
    () => answerFiles.map(file => file.extractedText).filter(Boolean).join('\n\n'),
    [answerFiles]
  );

  const parsedPaper = useMemo(() => parsePaper(questionPaperText), [questionPaperText]);
  const filledManual = useMemo(
    () => manual.filter(question => question.prompt.trim() && question.answer.trim()),
    [manual]
  );
  const manualPaper = useMemo(
    () =>
      paperFromManual(
        filledManual.map((question, index) => ({
          key: String(index + 1),
          prompt: question.prompt,
          marks: Number(question.marks),
          criteria: question.criteria,
        })),
        board
      ),
    [filledManual, board]
  );
  const basePaper = questionPaperText.trim() ? parsedPaper : manualPaper;
  const paper = useMemo(() => withMarksOverrides(basePaper, overrides), [basePaper, overrides]);

  const extracting = questionFiles.some(file => file.extracting) || answerFiles.some(file => file.extracting);
  const unresolved = paper.questions.filter(question => question.max === null);
  const attachmentIssues = [...questionFiles, ...answerFiles].flatMap(file => file.warnings);
  const totalMarks = paper.questions.reduce((sum, question) => sum + (question.max ?? 0), 0);

  function setManualQuestion(id: number, patch: Partial<ManualQuestion>) {
    setManual(previous => previous.map(question => (question.id === id ? { ...question, ...patch } : question)));
    setReport(null);
  }

  function addManualQuestion() {
    setManual(previous => [...previous, { id: Date.now(), prompt: '', answer: '', marks: 2, criteria: '' }]);
    setReport(null);
  }

  async function addFiles(fileList: FileList | null, kind: 'question' | 'answer') {
    if (!fileList?.length) return;
    const files = Array.from(fileList);
    setError('');
    setReport(null);
    if (kind === 'question') setOverrides({});

    const created: Attachment[] = files.map((file, index) => ({
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      type: file.type || 'unknown',
      size: file.size,
      extracting: true,
      extractedText: '',
      warnings: [],
      error: null,
      pageCount: 0,
    }));
    const update = kind === 'question' ? setQuestionFiles : setAnswerFiles;
    update(previous => [...previous, ...created]);

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const attachment = created[index];
      try {
        const document = await extractDocument(file, setStatus);
        update(previous =>
          previous.map(item =>
            item.id === attachment.id
              ? {
                  ...item,
                  extracting: false,
                  extractedText: document.text,
                  warnings: document.warnings,
                  pageCount: document.pages.length,
                }
              : item
          )
        );
        setReport(null);
      } catch (issue) {
        const message = issue instanceof Error ? issue.message : `Could not read ${file.name}.`;
        update(previous =>
          previous.map(item => (item.id === attachment.id ? { ...item, extracting: false, error: message } : item))
        );
        setError(message);
      }
    }
    setStatus('');
  }

  function removeAttachment(kind: 'question' | 'answer', id: string) {
    if (kind === 'question') {
      setQuestionFiles(previous => previous.filter(file => file.id !== id));
      setOverrides({});
    } else {
      setAnswerFiles(previous => previous.filter(file => file.id !== id));
    }
    setReport(null);
  }

  function resetAll() {
    setManual(initialQuestions);
    setQuestionFiles([]);
    setAnswerFiles([]);
    setOverrides({});
    setReport(null);
    setError('');
    setStatus('');
  }

  async function checkAiConnection() {
    if (aiCheck.state === 'checking') return;
    setAiCheck({ state: 'checking', message: 'Contacting the marking model with a one-line test…' });
    const started = performance.now();
    try {
      const chat = createPuterChat({ retries: 0 });
      const result = await chat(
        [
          { role: 'system', content: 'You are a connection test. Reply with JSON only.' },
          { role: 'user', content: 'Reply with exactly {"ok": true} and nothing else.' },
        ],
        { maxTokens: 24, temperature: 0, timeoutMs: 30_000 }
      );
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      if (/ok/i.test(result.text)) {
        setAiCheck({ state: 'ok', message: `Connected to ${result.model} in ${seconds}s.` });
      } else {
        setAiCheck({
          state: 'error',
          message: `The AI answered but not as expected: “${result.text.slice(0, 80)}”.`,
        });
      }
    } catch (issue) {
      setAiCheck({ state: 'error', message: friendlyAiMessage(issue) });
    }
  }

  async function retryFailed() {
    if (!report || inFlightRef.current || extracting) return;
    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;
    setBusy(true);
    setError('');
    setStatus('Re-marking the answers that could not be verified…');
    try {
      const usingUpload = questionPaperText.trim().length > 0;
      const next = await retryUnresolvedQuestions({
        report,
        answerText: answersForMarking(usingUpload),
        board,
        grade,
        chat: createPuterChat(),
        paperText: usingUpload ? questionPaperText : undefined,
        onProgress: setStatus,
        signal: controller.signal,
      });
      setReport(next);
    } catch (issue) {
      setError(friendlyAiMessage(issue));
    } finally {
      abortRef.current = null;
      inFlightRef.current = false;
      setBusy(false);
      setStatus('');
    }
  }

  async function evaluate() {
    if (inFlightRef.current || extracting) return;
    setError('');
    setReport(null);

    const usingUpload = questionPaperText.trim().length > 0;
    if (usingUpload && !answerSheetText.trim()) {
      setError('Add the answer sheet that belongs with this question paper.');
      return;
    }
    if (!usingUpload) {
      if (!filledManual.length) {
        setError('Upload your question paper and answer sheet, or type at least one question and answer.');
        return;
      }
      const incomplete = manual.some(question => (question.prompt.trim() || question.answer.trim()) && !(question.prompt.trim() && question.answer.trim()));
      if (incomplete) {
        setError('Add both the question and the answer for every row you started.');
        return;
      }
      if (
        manual.some(
          question =>
            question.prompt.trim() &&
            (!Number.isFinite(Number(question.marks)) || Number(question.marks) <= 0 || Number(question.marks) > 100)
        )
      ) {
        setError('Each question needs a maximum mark greater than 0 and no higher than 100.');
        return;
      }
    }
    if (!paper.questions.length) {
      setError(
        usingUpload
          ? 'No numbered questions were detected in the question paper. Check the scan or type the questions manually.'
          : 'Add at least one question to mark.'
      );
      return;
    }
    if (paper.questions.length > MAX_QUESTIONS_PER_RUN) {
      setError(`This paper has ${paper.questions.length} questions. Paperwise marks up to ${MAX_QUESTIONS_PER_RUN} at a time; split it into parts.`);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;
    setBusy(true);
    setStatus('Starting automatic marking…');
    try {
      const result = await evaluatePaper({
        paper,
        paperText: usingUpload ? questionPaperText : undefined,
        answerText: answersForMarking(usingUpload),
        board,
        grade,
        chat: createPuterChat(),
        onProgress: setStatus,
        signal: controller.signal,
      });
      setReport(result);
      setOverrides(previous => {
        const next = { ...previous };
        for (const question of result.paper.questions) {
          if (question.max !== null) next[question.key] = question.max;
        }
        return next;
      });
    } catch (issue) {
      if (issue instanceof MarksUnresolvedError) {
        setError(
          `Confirm the maximum marks for ${issue.questions.map(question => question.ref).join(', ')}. Paperwise will not guess printed marks.`
        );
      } else {
        const message = issue instanceof Error ? issue.message : '';
        const alreadyClear = /^(Paperwise|No questions|This paper)/.test(message);
        setError(alreadyClear ? message : friendlyAiMessage(issue));
      }
    } finally {
      abortRef.current = null;
      inFlightRef.current = false;
      setBusy(false);
      setStatus('');
    }
  }

  const percentage = report && report.paperTotal > 0 ? Math.round((report.awarded / report.paperTotal) * 100) : 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img src="/paperwise-icon.svg" alt="Paperwise app logo" />
          </div>
          <div>
            <strong>Paperwise</strong>
            <span>AI exam checker</span>
          </div>
        </div>
        <div className="side-label">WORKSPACE</div>
        <button className="side-item active">
          <SlidersHorizontal size={17} /> New evaluation
        </button>
        <button className="side-item" onClick={resetAll}>
          <FileText size={17} /> Start fresh
        </button>
        <div className="sidebar-bottom">
          <ShieldCheck size={18} />
          <span>
            Private by design
            <br />
            <small>Pages are read on your device. Only extracted text is sent to the AI for marking.</small>
          </span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="crumb">
            Workspace <span>/</span> <b>New evaluation</b>
          </div>
          <div className="top-pill">
            <span className="status-dot" />
            {busy ? 'Marking…' : report ? 'Marked' : 'Ready to check'}
          </div>
        </header>

        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <Sparkles size={14} /> YOUR PERSONAL EXAMINER
            </div>
            <h1>
              Check your paper.
              <br />
              <em>Understand every mark.</em>
            </h1>
            <p>
              Upload your question paper and answer sheet to get question-wise feedback and a clearer picture of what to
              revise.
            </p>
          </div>
          <div className="hero-art">
            <div className="art-sheet">
              <div className="sheet-line short" />
              <div className="sheet-line" />
              <div className="sheet-line" />
              <div className="tick-row">
                <CheckCircle2 size={16} />
                <span>Key point identified</span>
              </div>
              <div className="tick-row">
                <CheckCircle2 size={16} />
                <span>Partial marks considered</span>
              </div>
              <div className="score-stamp">?</div>
            </div>
            <div className="art-spark">✳</div>
          </div>
        </section>

        <div className="content-grid">
          <section className="form-column">
            <div className="section-heading">
              <div>
                <span className="step">01</span>
                <div>
                  <h2>Set up your paper</h2>
                  <p>Choose your exam context if useful. It helps the examiner use the right expectations.</p>
                </div>
              </div>
              <span className="optional">ABOUT THE EXAM</span>
            </div>
            <div className="panel">
              <div className="field-grid">
                <label>
                  Board or curriculum
                  <select value={board} onChange={event => setBoard(event.target.value)}>
                    <option>Any board</option>
                    <option>CBSE</option>
                    <option>ICSE</option>
                    <option>ISC</option>
                    <option>IB</option>
                    <option>Cambridge</option>
                    <option>State board</option>
                    <option>Other</option>
                  </select>
                </label>
                <label>
                  Class or level
                  <select value={grade} onChange={event => setGrade(event.target.value)}>
                    <option>Any class</option>
                    {Array.from({ length: 12 }, (_, index) => (
                      <option key={index}>Class {index + 1}</option>
                    ))}
                    <option>University</option>
                    <option>Competitive exam</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="section-heading">
              <div>
                <span className="step">02</span>
                <div>
                  <h2>Upload your question paper</h2>
                  <p>Paperwise reads the questions, their printed marks, sections and internal choices.</p>
                </div>
              </div>
              <span className="optional">INPUT</span>
            </div>
            <div className="upload-zone">
              <input
                id="question-paper-files"
                type="file"
                multiple
                accept="image/*,.heic,.heif,.pdf,.txt,.md"
                onChange={event => {
                  void addFiles(event.target.files, 'question');
                  event.target.value = '';
                }}
              />
              <label htmlFor="question-paper-files" className="upload-content">
                <div className="upload-icon">
                  <Upload size={22} />
                </div>
                <strong>Choose question paper files</strong>
                <span>Photos, scanned pages, PDFs, or text files</span>
                <small>JPG · PNG · HEIC · PDF</small>
              </label>
            </div>

            {questionFiles.length > 0 && (
              <div className="attachment-list">
                {questionFiles.map(file => (
                  <div className="attachment" key={file.id}>
                    <div className="file-icon">
                      {file.type.startsWith('image/') ? <Image size={17} /> : <FileText size={17} />}
                    </div>
                    <div className="file-info">
                      <strong>{file.name}</strong>
                      <span>
                        {file.type || 'File'} · {(file.size / 1024).toFixed(0)} KB
                        {file.pageCount > 1 ? ` · ${file.pageCount} pages` : ''}
                      </span>
                      <span className={file.extractedText && !file.extracting && !file.error ? 'extraction-status' : ''}>
                        {file.extracting
                          ? 'Reading text…'
                          : file.error
                            ? 'Could not read this file'
                            : file.extractedText
                              ? 'Text extracted'
                              : ''}
                      </span>
                    </div>
                    <button
                      aria-label={'Remove question paper ' + file.name}
                      onClick={() => removeAttachment('question', file.id)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {attachmentIssues.length > 0 && (
              <div className="warn-list">
                {attachmentIssues.map((warning, index) => (
                  <p key={index}>
                    <AlertCircle size={14} /> {warning}
                  </p>
                ))}
              </div>
            )}

            {questionPaperText.trim() && (
              <div className="paper-summary">
                <div className="paper-summary-head">
                  <strong>{paperSummaryLabel(parsedPaper)}</strong>
                  <span>
                    {parsedPaper.printedTotal !== null
                      ? `${parsedPaper.resolvedTotal} of ${parsedPaper.printedTotal} marks found`
                      : `${parsedPaper.resolvedTotal} marks found`}
                  </span>
                </div>
                {parsedPaper.printedTotal !== null &&
                  Math.abs(parsedPaper.printedTotal - parsedPaper.resolvedTotal) > 0.01 && (
                    <p className="paper-mismatch" role="alert">
                      <AlertTriangle size={14} /> The paper prints {parsedPaper.printedTotal} marks, but{" "}
                      {parsedPaper.resolvedTotal} were recognised. Check the question chips below — a question or its printed
                      mark may not have been read. Paperwise will not invent the missing marks.
                    </p>
                  )}
                <div className="ref-chips">
                  {parsedPaper.questions.slice(0, 32).map(question => (
                    <span key={question.key} className={question.max === null ? 'ref-chip missing-mark' : 'ref-chip'}>
                      {question.ref}
                      {question.max !== null ? ` · ${formatMarks(question.max)}` : ' · ?'}
                    </span>
                  ))}
                  {parsedPaper.questions.length > 32 && (
                    <span className="ref-chip">+{parsedPaper.questions.length - 32} more</span>
                  )}
                </div>
                {parsedPaper.sections.length > 0 && (
                  <p className="hint">
                    {parsedPaper.sections
                      .map(section => `${section.name}${section.marksPerQuestion ? ` · ${section.marksPerQuestion} per question` : ''}`)
                      .join(' · ')}
                  </p>
                )}
                {!parsedPaper.questions.length && (
                  <p className="hint">
                    No numbered questions were detected. Check the extracted pages, or type your questions manually below.
                  </p>
                )}
                {parsedPaper.warnings.length > 0 && (
                  <details className="report-notes">
                    <summary>Paper reading notes ({parsedPaper.warnings.length})</summary>
                    <ul>
                      {parsedPaper.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            <div className="section-heading">
              <div>
                <span className="step">03</span>
                <div>
                  <h2>Upload your answer sheet</h2>
                  <p>Answers can be in any order, continued across pages, or written as photos of your script.</p>
                </div>
              </div>
              <span className="optional">YOUR WORK</span>
            </div>
            <div className="upload-zone">
              <input
                id="answer-sheet-files"
                type="file"
                multiple
                accept="image/*,.heic,.heif,.pdf,.txt,.md"
                onChange={event => {
                  void addFiles(event.target.files, 'answer');
                  event.target.value = '';
                }}
              />
              <label htmlFor="answer-sheet-files" className="upload-content">
                <div className="upload-icon">
                  <Upload size={22} />
                </div>
                <strong>Choose answer sheet files</strong>
                <span>Photos, scanned pages, PDFs, or text files</span>
                <small>JPG · PNG · HEIC · PDF</small>
              </label>
            </div>
            {answerFiles.length > 0 && (
              <div className="attachment-list">
                {answerFiles.map(file => (
                  <div className="attachment" key={file.id}>
                    <div className="file-icon">
                      {file.type.startsWith('image/') ? <Image size={17} /> : <FileText size={17} />}
                    </div>
                    <div className="file-info">
                      <strong>{file.name}</strong>
                      <span>
                        {file.type || 'File'} · {(file.size / 1024).toFixed(0)} KB
                        {file.pageCount > 1 ? ` · ${file.pageCount} pages` : ''}
                      </span>
                      <span className={file.extractedText && !file.extracting && !file.error ? 'extraction-status' : ''}>
                        {file.extracting
                          ? 'Reading text…'
                          : file.error
                            ? 'Could not read this file'
                            : file.extractedText
                              ? 'Text extracted'
                              : ''}
                      </span>
                    </div>
                    <button aria-label={'Remove answer sheet ' + file.name} onClick={() => removeAttachment('answer', file.id)}>
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <details className="manual-entry">
              <summary>
                <Plus size={15} /> Add answers manually instead
              </summary>
              <p className="hint">
                Use this when you want to type the questions yourself. Uploaded papers take priority over this section.
              </p>
              <div className="manual-total">{totalMarks} marks in typed questions</div>
              {manual.map((question, index) => (
                <div className="question-card" key={question.id}>
                  <div className="question-top">
                    <span className="q-number">Q{index + 1}</span>
                    <label>
                      Marks
                      <input
                        aria-label={'Maximum marks for question ' + (index + 1)}
                        type="number"
                        min="0"
                        max="100"
                        step="0.5"
                        value={question.marks}
                        onChange={event => setManualQuestion(question.id, { marks: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                  <label>
                    Question
                    <textarea
                      value={question.prompt}
                      onChange={event => setManualQuestion(question.id, { prompt: event.target.value })}
                      placeholder="Paste or type the question..."
                      rows={2}
                    />
                  </label>
                  <label>
                    Your answer
                    <textarea
                      value={question.answer}
                      onChange={event => setManualQuestion(question.id, { answer: event.target.value })}
                      placeholder="Type your answer as you wrote it..."
                      rows={3}
                    />
                  </label>
                  <label>
                    Marking points <span className="label-note">optional</span>
                    <textarea
                      value={question.criteria}
                      onChange={event => setManualQuestion(question.id, { criteria: event.target.value })}
                      placeholder="Any points your teacher requires, one per line"
                      rows={2}
                    />
                  </label>
                </div>
              ))}
              <button className="add-question" onClick={addManualQuestion}>
                <Plus size={17} /> Add another question
              </button>
            </details>

            {unresolved.length > 0 && (
              <div className="marks-confirm">
                <strong>Confirm maximum marks</strong>
                <p>
                  The printed maximum could not be verified for these questions. Enter the marks from your paper so nothing
                  is guessed.
                </p>
                {unresolved.map(question => (
                  <label key={question.key}>
                    <span>
                      {question.ref}
                      <small>{question.text.slice(0, 80)}{question.text.length > 80 ? '…' : ''}</small>
                    </span>
                    <input
                      aria-label={`Maximum marks for ${question.ref}`}
                      type="number"
                      min="0.5"
                      max="100"
                      step="0.5"
                      value={overrides[question.key] ?? ''}
                      onChange={event =>
                        setOverrides(previous => ({ ...previous, [question.key]: Number(event.target.value) }))
                      }
                    />
                  </label>
                ))}
              </div>
            )}

            <div className="model-notice">
              <AlertCircle size={18} />
              <div>
                <strong>How marking works</strong>
                <p>
                  Each answer is marked against its own question and printed maximum, including partial marks. An AI mark is
                  never accepted without a valid explanation.
                </p>
              </div>
            </div>

            <div className={`model-notice ai-check ${aiCheck.state === 'ok' ? 'ok' : aiCheck.state === 'error' ? 'failed' : ''}`}>
              <Wifi size={18} />
              <div>
                <strong>AI connection</strong>
                <p>
                  {aiCheck.state === 'idle'
                    ? 'Marking needs a one-time free Puter sign-in. Test the real model before a long paper.'
                    : aiCheck.message}
                </p>
                <button onClick={() => void checkAiConnection()} disabled={aiCheck.state === 'checking'}>
                  {aiCheck.state === 'checking' ? 'Checking…' : 'Check AI connection'}
                </button>
              </div>
            </div>

            {status && (
              <div className="model-notice" role="status">
                <Sparkles size={18} />
                <div>
                  <strong>Working</strong>
                  <p>{status}</p>
                  <p className="elapsed">
                    {elapsedLabel(elapsed)} · Large papers are marked in batches, so this can take a few minutes. Stopping keeps
                    nothing.
                  </p>
                  <button onClick={() => abortRef.current?.abort()}>Stop</button>
                </div>
              </div>
            )}

            {error && (
              <div className="error-banner">
                <AlertCircle size={17} />
                <span>{error}</span>
              </div>
            )}

            <button className="evaluate-button" onClick={() => void evaluate()} disabled={busy || extracting}>
              {busy || extracting ? <Loader2 size={18} className="spin" /> : <Sparkles size={18} />}
              {busy ? 'Marking your paper…' : extracting ? 'Reading your files…' : 'Run automatic marking'}{' '}
              {!busy && !extracting && <ArrowRight size={18} />}
            </button>

            <details className="report-notes privacy-note">
              <summary>
                <ShieldCheck size={14} /> How your papers are handled
              </summary>
              <ul>
                <li>
                  Files are opened, read and OCR'd in your browser. Paperwise has no server that receives or stores your
                  uploads.
                </li>
                <li>
                  When you run marking, the extracted question and answer text is sent to Puter.js, which passes it to a
                  DeepSeek model. That is a third-party AI service outside Paperwise. Do not upload someone else's paper
                  without their permission.
                </li>
                <li>Nothing is saved to an account, and the extracted text is discarded when you close or refresh the tab.</li>
                <li>Marks are estimates. Check them before using them for anything official.</li>
              </ul>
            </details>
          </section>

          <aside className="results-column">
            <div className="results-head">
              <div>
                <span className="step">RESULTS</span>
                <h2>Your evaluation</h2>
              </div>
            </div>
            {report ? (
              <div className="result-panel">
                <div className="score-block">
                  <span>Estimated score</span>
                  <div>
                    <strong>{formatMarks(report.awarded)}</strong>
                    <span> / {formatMarks(report.paperTotal)}</span>
                  </div>
                  <div className="score-track">
                    <span style={{ width: percentage + '%' }} />
                  </div>
                  <small>
                    {percentage}% · {report.gradedCount} marked · {report.unattemptedCount} not attempted
                    {report.unresolvedCount ? ` · ${report.unresolvedCount} need review` : ''}
                  </small>
                  {!report.complete && (
                    <>
                      <p className="provisional">
                        Partial result: {report.unresolvedCount} answer{report.unresolvedCount === 1 ? '' : 's'} could not be
                        verified and {report.unresolvedCount === 1 ? 'is' : 'are'} not counted in the total.
                      </p>
                      <button className="secondary-button retry-button" onClick={() => void retryFailed()} disabled={busy}>
                        <RefreshCw size={15} /> Re-mark the {report.unresolvedCount} unfinished answer
                        {report.unresolvedCount === 1 ? '' : 's'}
                      </button>
                    </>
                  )}
                </div>

                {report.warnings.length > 0 && (
                  <details className="report-notes">
                    <summary>Marking notes ({report.warnings.length})</summary>
                    <ul>
                      {report.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}

                {report.grades.map(question => (
                  <div className="result-question" key={question.key}>
                    <div className="result-q-head">
                      <strong>{question.ref}</strong>
                      <span className="result-score">
                        <span className={`status-chip ${question.status}`}>{STATUS_LABEL[question.status]}</span>
                        <b>{question.status === 'unresolved' ? '—' : `${formatMarks(question.awarded)} / ${formatMarks(question.max)}`}</b>
                      </span>
                    </div>
                    {question.status === 'unresolved' ? (
                      <p className="result-note">
                        {question.error ?? 'This answer could not be marked automatically.'} It was not recorded as zero.
                      </p>
                    ) : (
                      <>
                        {question.correctPoints.length > 0 && (
                          <div className="point-list good">
                            {question.correctPoints.map((point, index) => (
                              <p key={index}>
                                <CheckCircle2 size={13} /> {point}
                              </p>
                            ))}
                          </div>
                        )}
                        {question.missingPoints.length > 0 && (
                          <div className="point-list missing">
                            {question.missingPoints.map((point, index) => (
                              <p key={index}>
                                <AlertCircle size={13} /> {point}
                              </p>
                            ))}
                          </div>
                        )}
                        {question.mistakes.length > 0 && (
                          <div className="point-list mistake">
                            {question.mistakes.map((mistake, index) => (
                              <p key={index}>
                                <X size={13} /> {mistake}
                              </p>
                            ))}
                          </div>
                        )}
                        <p className="result-note">{question.feedback}</p>
                        {question.confidence && <span className="confidence">Confidence: {question.confidence}</span>}
                      </>
                    )}
                  </div>
                ))}

                <button className="secondary-button" onClick={() => setReport(null)}>
                  Edit answers
                </button>
                <p className="provider-note">Marked with {report.provider} · {report.model}</p>
              </div>
            ) : (
              <div className="empty-results">
                <div className="empty-illustration">
                  <ClipboardCheck size={38} />
                  <span>✦</span>
                </div>
                <h3>Your marks will appear here</h3>
                <p>Upload your question paper and answer sheet, then run automatic marking.</p>
                <div className="empty-checks">
                  <span>
                    <CheckCircle2 size={15} /> Question-wise marks
                  </span>
                  <span>
                    <CheckCircle2 size={15} /> Missing points and mistakes
                  </span>
                  <span>
                    <CheckCircle2 size={15} /> Score that adds up
                  </span>
                </div>
              </div>
            )}

            <div className="trust-card">
              <ShieldCheck size={19} />
              <div>
                <strong>Designed for transparent marking</strong>
                <p>Every deduction is explained. Answers that cannot be verified are flagged for review instead of being marked wrong.</p>
              </div>
            </div>

            <div className="next-card">
              <div className="next-icon">
                <Sparkles size={17} />
              </div>
              <div>
                <strong>Free AI examiner</strong>
                <p>
                  Marking uses DeepSeek through Puter.js, with no API key needed. Scanned pages are read on your device in
                  English and Hindi. Review every estimated score before relying on it.
                </p>
                <span>Experimental · review all scores</span>
              </div>
            </div>
          </aside>
        </div>

        <footer>
          Paperwise <span>·</span> Independent prototype <span>·</span> Not connected to CRAM AI
        </footer>
      </main>
    </div>
  );
}

export default App;
