import { useMemo, useState } from 'react';
import { api } from '@appdeploy/client';
import { extractTextFromFile } from './fileText';
import {
  Upload,
  FileText,
  Image,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  ClipboardCheck,
  X,
  Plus,
  ArrowRight,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';

type Question = {
  id: number;
  prompt: string;
  answer: string;
  marks: number;
  criteria: string;
};
type Attachment = { id: number; name: string; type: string; size: number; extracting?: boolean; extractedText?: string; extractionError?: boolean };
type Result = {
  id: number;
  ref?: string;
  score: number;
  max: number;
  matched: string[];
  missing: string[];
  note: string;
};

const initialQuestions: Question[] = [
  { id: 1, prompt: '', answer: '', marks: 3, criteria: '' },
];

function App() {
  const [board, setBoard] = useState('Any board');
  const [grade, setGrade] = useState('Any class');
  const mode = 'automatic' as const;
  const [questions, setQuestions] = useState<Question[]>(initialQuestions);
  const [questionAttachments, setQuestionAttachments] = useState<Attachment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [results, setResults] = useState<Result[] | null>(null);
  const [resultMethod, setResultMethod] = useState<'scheme' | 'ai' | null>(null);
  const [modelStatus, setModelStatus] = useState('');
  const [error, setError] = useState('');
  const [questionPaperText, setQuestionPaperText] = useState('');
  const [answerSheetText, setAnswerSheetText] = useState('');

  const totalMarks = useMemo(
    () =>
      questions.reduce((sum, q) => sum + Math.max(0, Number(q.marks) || 0), 0),
    [questions]
  );
  const awarded = results?.reduce((sum, r) => sum + r.score, 0) ?? 0;
  const maxAwarded = results?.reduce((sum, r) => sum + r.max, 0) ?? 0;

  function updateQuestion(
    id: number,
    key: keyof Question,
    value: string | number
  ) {
    setQuestions(prev =>
      prev.map(q => (q.id === id ? { ...q, [key]: value } : q))
    );
    setResults(null);
  }

  function addQuestion() {
    setQuestions(prev => [
      ...prev,
      { id: Date.now(), prompt: '', answer: '', marks: 2, criteria: '' },
    ]);
    setResults(null);
  }

  function handleFiles(fileList: FileList | null, kind: 'question' | 'answer') {
    if (!fileList) return;
    const incoming = Array.from(fileList).filter(
      file =>
        file.type.startsWith('image/') ||
        file.type === 'application/pdf' ||
        file.type.startsWith('text/') ||
        /\.(txt|md|csv|pdf)$/i.test(file.name)
    );
    if (incoming.length !== fileList.length) {
      setError('Some files were skipped. Please use images, PDFs, or text files.');
    }
    const mapped = incoming.map(file => ({
      file,
      id: Date.now() + Math.random(),
      name: file.name,
      type: file.type,
      size: file.size,
      extracting: true,
    }));
    const initial = mapped.map(({ file: _file, ...attachment }) => attachment);
    if (kind === 'question') {
      setQuestionAttachments(prev => [...prev, ...initial]);
    } else {
      setAttachments(prev => [...prev, ...initial]);
    }
    const updateAttachment = (id: number, patch: Partial<Attachment>) => {
      const update = (items: Attachment[]) => items.map(item => item.id === id ? { ...item, ...patch } : item);
      if (kind === 'question') setQuestionAttachments(prev => update(prev));
      else setAttachments(prev => update(prev));
    };
    void (async () => {
      for (const item of mapped) {
        try {
          setModelStatus('Reading text from ' + item.name + '…');
          const text = await extractTextFromFile(item.file, setModelStatus);
          if (!text.trim()) throw new Error('No readable text was found in ' + item.name + '.');
          updateAttachment(item.id, { extracting: false, extractedText: text, extractionError: false });
          if (kind === 'question') {
            setQuestionPaperText(prev => prev ? prev + '\n\n' + text : text);
          } else {
            setAnswerSheetText(prev => prev ? prev + '\n\n' + text : text);
          }
          setResults(null);
        } catch (error) {
          updateAttachment(item.id, { extracting: false, extractionError: true });
          setError(error instanceof Error ? error.message : 'Text extraction failed for ' + item.name + '.');
        }
      }
      setModelStatus('');
    })();
  }

  async function evaluate() {
    setError('');
    const hasQuestionPaper = !!questionPaperText.trim();
    const hasAnswerSheet = !!answerSheetText.trim();
    if (hasQuestionPaper !== hasAnswerSheet) {
      setError('Upload both the question paper and the answer sheet, or enter questions and answers manually.');
      return;
    }
    if (!hasQuestionPaper && questions.length > 15) {
      setError('Automatic marking supports up to 15 manually entered questions per evaluation.');
      return;
    }
    if (!hasQuestionPaper && questions.some(q => !q.prompt.trim() || !q.answer.trim())) {
      setError('Add both a question and your answer before evaluation.');
      return;
    }
    if (!hasQuestionPaper && questions.some(q => !Number.isFinite(Number(q.marks)) || Number(q.marks) <= 0 || Number(q.marks) > 100)) {
      setError('Enter a maximum mark greater than 0 and no higher than 100 for every question.');
      return;
    }
    if (mode === 'automatic') {
      setResults(null);
      setResultMethod(null);
      setModelStatus('Preparing automatic marking…');
      try {
        if (!hasQuestionPaper) {
          setModelStatus('Sending answers for AI marking…');
          const response = await api.post('/api/grade', {
            board,
            grade,
            questions: questions.map(q => ({
              id: q.id,
              prompt: q.prompt,
              answer: q.answer,
              marks: Number(q.marks),
              criteria: q.criteria,
            })),
          });
          const payload = response?.data;
          if (!Array.isArray(payload?.results) || payload.results.length !== questions.length) {
            throw new Error('The grading service returned incomplete results. No scores were accepted.');
          }
          const seen = new Set<number>();
          const typedResults: Result[] = payload.results.map((item: any) => {
            const question = questions.find(q => q.id === Number(item?.id));
            const score = Number(item?.score);
            if (!question || seen.has(question.id) || !Number.isFinite(score) || score < 0 || score > Number(question.marks) || typeof item?.rationale !== 'string' || item.rationale.trim().length < 4) {
              throw new Error('The grading service returned an invalid or duplicate result. No scores were accepted.');
            }
            seen.add(question.id);
            return { id: question.id, score, max: Number(question.marks), matched: [], missing: [], note: item.rationale.trim() };
          });
          if (seen.size !== questions.length) throw new Error('The grading service omitted one or more answers. No scores were accepted.');
          setResults(typedResults);
          setResultMethod('ai');
          setModelStatus('');
          return;
        }
        const puter = (window as any).puter;
        if (!puter?.ai?.chat) throw new Error('Puter.js did not load. Check your connection and reload Paperwise.');
        setModelStatus('Checking your uploaded answers…');
        // Build a compact examiner guide once; never resend the full paper and
        // answer sheet with every grading request.
        const splitBounded = (value: string, limit: number) => {
          const pieces: string[] = [];
          let current = '';
          const units = value
            .replace(/\r/g, '')
            .split(/\n+/)
            .map(part => part.trim())
            .filter(Boolean);
          for (const unit of units) {
            let remaining = unit;
            while (remaining.length > limit) {
              let cut = remaining.lastIndexOf(' ', limit);
              if (cut < Math.floor(limit * 0.6)) cut = limit;
              const segment = remaining.slice(0, cut).trim();
              if (segment) {
                const candidate = current ? current + '\n' + segment : segment;
                if (candidate.length > limit && current) {
                  pieces.push(current);
                  current = segment;
                } else {
                  current = candidate;
                }
              }
              remaining = remaining.slice(cut).trim();
            }
            if (remaining) {
              const candidate = current ? current + '\n' + remaining : remaining;
              if (candidate.length > limit && current) {
                pieces.push(current);
                current = remaining;
              } else {
                current = candidate;
              }
            }
          }
          if (current) pieces.push(current);
          return pieces;
        };
        let paperGuide = '';
        const answerChunks: string[] = [];
        const attemptedAnswerRefs = new Set<string>();
        if (hasQuestionPaper) {
          // Start with small windows and automatically subdivide any excerpt
          // whose response is truncated or malformed. Never fail solely because
          // one chunk was too large for the provider's output budget.
          // Overlap adjacent excerpts so section-level mark and attempt rules
          // remain visible alongside questions near chunk boundaries.
          const paperChunks: string[] = [];
          // Larger overlapping windows reduce the chance that a question,
          // its wrapped continuation, or a section rule is separated at a
          // provider-request boundary. Prefer line/question boundaries.
          const normalizedPaper = questionPaperText
            .replace(/\r/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          const paperWindow = 1200;
          const paperOverlap = 360;
          for (let start = 0; start < normalizedPaper.length;) {
            let end = Math.min(normalizedPaper.length, start + paperWindow);
            if (end < normalizedPaper.length) {
              const candidates = [
                normalizedPaper.lastIndexOf('\n', end),
                normalizedPaper.lastIndexOf('. ', end),
                normalizedPaper.lastIndexOf('] ', end),
                normalizedPaper.lastIndexOf(') ', end),
                normalizedPaper.lastIndexOf(' ', end),
              ];
              const boundary = candidates.find(point => point > start + Math.floor(paperWindow * 0.55));
              if (boundary !== undefined) end = boundary + 1;
            }
            const excerpt = normalizedPaper.slice(start, end).trim();
            if (excerpt) paperChunks.push(excerpt);
            if (end >= normalizedPaper.length) break;
            start = Math.max(start + 1, end - paperOverlap);
          }
          const guideParts: string[] = [];
          let processedParts = 0;
          const extractPaperPart = async (partText: string, depth = 0): Promise<void> => {
            const extractPrompt = 'Read this exam-paper excerpt and return ONLY compact JSON: {"rules":["short rule"],"questions":[{"ref":"Q1(a)","section":"A","max":2}]}. List every visible question/subquestion reference. Resolve each question maximum using all explicit instructions visible in this excerpt, including section headings, per-question marks, mark distributions such as 1x5=5, and instructions that every question in a section carries the same marks. If a section gives a total and a clear question count/distribution, calculate the per-question maximum only when unambiguous. Do not assign a section total to each question. Do not infer from common exam patterns. If the marks cannot be resolved from the excerpt, use max:null and explain the ambiguity in rules. Preserve section and attempt/choice instructions. No markdown.\nBOARD/CLASS: ' + board + ' / ' + grade + '\nEXCERPT:\n' + partText;
            const extractController = new AbortController();
            const extractTimeout = window.setTimeout(() => extractController.abort(), 120000);
            let extractResponse: any;
            try {
              extractResponse = await puter.ai.chat(extractPrompt, {
                model: 'deepseek/deepseek-v4.1-flash',
                temperature: 0,
                max_tokens: 700,
                normalize: true,
                fallback: true,
                signal: extractController.signal,
              });
            } finally {
              window.clearTimeout(extractTimeout);
            }
            const extractReason = String(extractResponse?.finish_reason ?? extractResponse?.choices?.[0]?.finish_reason ?? '').toLowerCase();
            const extractContent = extractResponse?.message?.content;
            const extractRaw = typeof extractContent === 'string' ? extractContent : Array.isArray(extractContent) ? extractContent.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n') : typeof extractResponse?.text === 'string' ? extractResponse.text : typeof extractResponse === 'string' ? extractResponse : '';
            const extractStart = extractRaw.indexOf('{');
            const extractEnd = extractRaw.lastIndexOf('}');
            let extracted: any = null;
            if (extractReason !== 'length' && extractReason !== 'max_tokens' && extractStart >= 0 && extractEnd > extractStart) {
              try { extracted = JSON.parse(extractRaw.slice(extractStart, extractEnd + 1)); } catch { extracted = null; }
            }
            if (!extracted || !Array.isArray(extracted.questions) || !Array.isArray(extracted.rules)) {
              // A window edge can contain only the tail of a wrapped line or
              // the continuation of a question captured in its overlapping
              // neighbour. Ignore such fragments only when they contain no
              // question label; a fragment containing a question must still
              // be recovered or the paper is rejected safely.
              const hasQuestionLabel = /\bQ(?:uestion)?\s*\d{1,2}\s*[.)]/i.test(partText);
              if (depth >= 7 || partText.length < 60) {
                if (!hasQuestionLabel) return;
                throw new Error('Paperwise could not reliably read a question in the uploaded paper. Check the page containing that question or upload a clearer scan. No scores were generated.');
              }
              const midpoint = Math.floor(partText.length / 2);
              const boundaries = [
                partText.lastIndexOf('\n', midpoint),
                partText.lastIndexOf('. ', midpoint),
                partText.lastIndexOf(' ', midpoint),
              ];
              const boundary = boundaries.find(point => point > partText.length * 0.3 && point < partText.length * 0.7) ?? midpoint;
              await extractPaperPart(partText.slice(0, boundary).trim(), depth + 1);
              await extractPaperPart(partText.slice(boundary).trim(), depth + 1);
              return;
            }
            guideParts.push(JSON.stringify({ rules: extracted.rules, questions: extracted.questions }));
            processedParts++;
            setModelStatus('Reading question paper (' + processedParts + ' parts checked)…');
          };
          for (const paperChunk of paperChunks) {
            await extractPaperPart(paperChunk);
          }
          const catalogue = new Map<string, { ref: string; section: string; max: number }>();
          const allRules = new Set<string>();
          for (const part of guideParts) {
            const parsedPart = JSON.parse(part);
            for (const rule of parsedPart.rules) {
              if (typeof rule === 'string' && rule.trim()) allRules.add(rule.trim());
            }
            for (const item of parsedPart.questions) {
              const ref = typeof item?.ref === 'string' ? item.ref.trim() : '';
              const maximum = Number(item?.max);
              if (!ref || !Number.isFinite(maximum) || maximum <= 0 || maximum > 100) {
                throw new Error('Paperwise could not confidently resolve the marks for ' + (ref || 'a detected question') + ' from the printed question or section instructions. Check that section’s marks and upload a clearer page. No scores were generated.');
              }
              const key = ref.toUpperCase().replace(/\s+/g, '');
              const existing = catalogue.get(key);
              if (existing && existing.max !== maximum) {
                throw new Error('The paper shows conflicting maximum marks for ' + ref + '. Check the question paper. No scores were generated.');
              }
              catalogue.set(key, {
                ref,
                section: typeof item.section === 'string' ? item.section : '',
                max: maximum,
              });
            }
          }
          if (!catalogue.size) throw new Error('No questions with clearly printed maximum marks could be identified. No scores were generated.');
          paperGuide = JSON.stringify({
            rules: Array.from(allRules),
            questions: Array.from(catalogue.values()),
          });
          answerChunks.push(...splitBounded(answerSheetText, 2600));
          if (!answerChunks.length) throw new Error('No readable answers were found in the uploaded answer sheet. No scores were generated.');
          // Independently inventory attempted answer references before grading.
          // This prevents a model response from silently omitting an answer.
          for (const answerChunk of answerChunks) {
            const inventoryPrompt = 'Identify every question/subquestion reference that has a student answer in this answer-sheet excerpt. Return ONLY JSON: {"attempted":["Q1(a)"]}. Do not list blank questions, instructions, or references merely mentioned in prose. Preserve the printed reference exactly. If no attempted answers are visible, return an empty array.\nEXCERPT:\n' + answerChunk;
            const inventoryResponse: any = await puter.ai.chat(inventoryPrompt, {
              model: 'deepseek/deepseek-v4.1-flash', temperature: 0, max_tokens: 500,
              normalize: true, fallback: true,
            });
            const inventoryContent = inventoryResponse?.message?.content;
            const inventoryRaw = typeof inventoryContent === 'string' ? inventoryContent : Array.isArray(inventoryContent) ? inventoryContent.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n') : typeof inventoryResponse?.text === 'string' ? inventoryResponse.text : typeof inventoryResponse === 'string' ? inventoryResponse : '';
            const inventoryStart = inventoryRaw.indexOf('{');
            const inventoryEnd = inventoryRaw.lastIndexOf('}');
            let inventory: any = null;
            if (inventoryStart >= 0 && inventoryEnd > inventoryStart) {
              try { inventory = JSON.parse(inventoryRaw.slice(inventoryStart, inventoryEnd + 1)); } catch { inventory = null; }
            }
            if (!inventory || !Array.isArray(inventory.attempted) || inventory.attempted.some((ref: any) => typeof ref !== 'string' || !ref.trim())) {
              throw new Error('Paperwise could not verify which answers were attempted in one part of the answer sheet. No scores were generated.');
            }
            for (const ref of inventory.attempted) attemptedAnswerRefs.add(ref.toUpperCase().replace(/\s+/g, ''));
          }
          if (!attemptedAnswerRefs.size) throw new Error('No attempted answers could be identified in the answer sheet. No scores were generated.');
        } else {
          for (let i = 0; i < questions.length; i += 3) {
            answerChunks.push(JSON.stringify(questions.slice(i, i + 3).map(q => ({ id: q.id, question: q.prompt, student_answer: q.answer, maximum_marks: Number(q.marks) }))));
          }
        }

        const allResults: Result[] = [];
        const acceptedRefs = new Set<string>();
        const catalogueByRef = new Map<string, number>();
        if (hasQuestionPaper) {
          const parsedGuide = JSON.parse(paperGuide);
          for (const item of parsedGuide.questions) {
            catalogueByRef.set(String(item.ref).toUpperCase().replace(/\s+/g, ''), Number(item.max));
          }
        }
        for (let batchIndex = 0; batchIndex < answerChunks.length; batchIndex++) {
          setModelStatus('Marking section ' + (batchIndex + 1) + ' of ' + answerChunks.length + '…');
          const batchPrompt = hasQuestionPaper
            ? 'Act as a careful school examiner. Use the compact question catalogue and printed attempt rules below. Grade ONLY answers in this excerpt; match question references even when out of order. Respect section attempt limits as far as the provided catalogue states. Accept equivalent wording and award fair partial marks for correct concepts, formulas and working. Never exceed the printed maximum. Return JSON only: {"results":[{"ref":"Q1(a)","score":1,"max":2,"rationale":"brief reason"}]}. Include only attempted answers visible in this excerpt. Keep rationale under 12 words.\nBOARD/CLASS: ' + board + ' / ' + grade + '\nQUESTION CATALOGUE AND RULES:\n' + paperGuide + '\nANSWER EXCERPT:\n' + answerChunks[batchIndex]
            : 'You are a cautious school examiner. Grade ONLY these answers. Accept equivalent wording and award partial credit for correct relevant ideas/steps. Never exceed maximum_marks. Return compact JSON only: {"results":[{"id":1,"score":0,"max":1,"rationale":"brief reason"}]}. Include exactly one result for each supplied question; preserve its id and maximum marks. Keep each rationale under 12 words. Input: ' + answerChunks[batchIndex];
          const controller = new AbortController();
          const requestTimeout = window.setTimeout(() => controller.abort(), 180000);
          let response: any;
          try {
            response = await puter.ai.chat(batchPrompt, {
              model: 'deepseek/deepseek-v4.1-flash',
              temperature: 0.1,
              max_tokens: 1200,
              normalize: true,
              fallback: true,
              signal: controller.signal,
            });
          } finally {
            window.clearTimeout(requestTimeout);
          }
          const finishReason = response?.finish_reason ?? response?.choices?.[0]?.finish_reason;
          if (finishReason === 'length' || finishReason === 'max_tokens') {
            throw new Error('A marking section exceeded the AI output limit. No scores were applied; please retry with clearer section breaks.');
          }
          if (finishReason === 'content_filter') throw new Error('The AI service declined this grading request. No scores were applied.');
          const responseContent = response?.message?.content;
          const raw = typeof responseContent === 'string' ? responseContent : Array.isArray(responseContent) ? responseContent.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n') : typeof response?.text === 'string' ? response.text : typeof response === 'string' ? response : '';
          const cleaned = raw.trim();
          const start = cleaned.indexOf('{');
          const end = cleaned.lastIndexOf('}');
          if (!raw.trim() || start < 0 || end <= start) throw new Error('The AI returned incomplete section data. No scores were applied.');
          let data: any;
          try { data = JSON.parse(cleaned.slice(start, end + 1)); } catch { throw new Error('The AI returned invalid section data. No scores were applied.'); }
          if (!Array.isArray(data.results) || data.results.length === 0) throw new Error('A marking section returned no results. No scores were applied.');
          const batchResults = data.results.map((r: any, index: number) => {
            const q = hasQuestionPaper ? undefined : questions.find(item => item.id === Number(r.id));
            const ref = hasQuestionPaper && typeof r.ref === 'string' ? r.ref.trim() : '';
            const refKey = ref.toUpperCase().replace(/\s+/g, '');
            const catalogueMaximum = hasQuestionPaper ? catalogueByRef.get(refKey) : undefined;
            const maximum = hasQuestionPaper ? Number(r.max) : Number(q?.marks);
            if ((!hasQuestionPaper && !q) ||
                (hasQuestionPaper && (!ref || catalogueMaximum === undefined || acceptedRefs.has(refKey) || maximum !== catalogueMaximum)) ||
                typeof r.score !== 'number' || !Number.isFinite(r.score) ||
                !Number.isFinite(maximum) || maximum <= 0 || maximum > 100 ||
                r.score < 0 || r.score > maximum ||
                (q && maximum !== Number(q.marks)) ||
                typeof r.rationale !== 'string' || r.rationale.trim().length < 4) {
              throw new Error('The marking service returned a missing, duplicate, unknown, or invalid question result. No scores were applied.');
            }
            if (hasQuestionPaper) acceptedRefs.add(refKey);
            return {
              id: allResults.length + index + 1,
              ref: hasQuestionPaper ? ref : undefined,
              score: Math.round(r.score * 100) / 100,
              max: maximum,
              matched: [],
              missing: [],
              note: r.rationale.trim(),
            };
          });
          if (!hasQuestionPaper && batchResults.length !== Math.min(3, questions.length - batchIndex * 3)) throw new Error('The AI omitted one or more manually entered questions. No scores were applied.');
          allResults.push(...batchResults);
        }
                if (!allResults.length) throw new Error('The AI returned no gradeable answers. No scores were generated.');
        if (hasQuestionPaper) {
          const missingAttempted = Array.from(attemptedAnswerRefs).filter(ref => !acceptedRefs.has(ref));
          if (missingAttempted.length) {
            throw new Error('The AI did not return marks for every detected attempted answer (' + missingAttempted.slice(0, 5).join(', ') + '). No scores were applied; please retry with a clearer answer sheet.');
          }
        }
        setResults(allResults);
        setResultMethod('ai');
        setModelStatus('');
      } catch (e) {
        const issue = e as { message?: string; code?: string; status?: number; statusCode?: number; upstreamCode?: string; upstreamStatus?: number; provider?: string; name?: string };
        const message = typeof issue?.message === 'string' ? issue.message : e instanceof Error ? e.message : 'The model request failed.';
        const rawDiagnostic = (() => { try { return JSON.stringify(e); } catch { return ''; } })();
        const code = typeof issue?.code === 'string' ? issue.code : '';
        const status = Number(issue?.status ?? issue?.statusCode ?? issue?.upstreamStatus ?? 0);
        const providerCode = typeof issue?.upstreamCode === 'string' ? issue.upstreamCode : '';
        const providerName = typeof issue?.provider === 'string' ? issue.provider : '';
        const diagnostic = [providerName, providerCode, status ? 'HTTP ' + status : '', code].filter(Boolean).join(' · ');
        setModelStatus('');
        if (code === 'network_error' || /network|fetch failed|failed to fetch|connection/i.test(message)) {
          setError('The connection to the AI service failed. Check your connection and retry. No score was generated.');
        } else if (status === 429 || /rate.?limit|quota exceeded/i.test(message)) {
          setError('The AI service is temporarily rate-limited. Wait a little and retry. No score was generated.');
        } else if (message.includes('model_not_configured') || status === 503 || message.includes('503')) {
          setError('Automatic marking is temporarily unavailable. No score was generated. Please try again shortly.');
        } else if (message.startsWith('LOCAL_MODEL: ')) {
          setError(message.replace('LOCAL_MODEL: ', ''));
        } else {
          const detailSource = message === 'The model request failed.' && rawDiagnostic ? rawDiagnostic : message;
          const safeDetail = detailSource.replace(/https?:\/\/\S+/g, '[service link]').replace(/[\r\n]+/g, ' ').slice(0, 220);
          setError('AI marking failed' + (diagnostic ? ' (' + diagnostic + ')' : '') + (safeDetail ? ': ' + safeDetail : '.') + ' No score was generated.');
        }
      }
      return;
    }
    const next = questions.map(q => {
      const criteria = q.criteria
        .split(/[\n,;•]+/)
        .map(x => x.trim())
        .filter(Boolean);
      const answer = q.answer.toLowerCase();
      const matched = criteria.filter(point =>
        answer.includes(point.toLowerCase())
      );
      const score = criteria.length
        ? Math.round((matched.length / criteria.length) * Number(q.marks) * 2) /
          2
        : 0;
      const missing = criteria.filter(point => !matched.includes(point));
      return {
        id: q.id,
        score: Math.min(Number(q.marks), score),
        max: Number(q.marks),
        matched,
        missing,
        note: criteria.length
          ? 'Keyword-only draft estimate. This does not understand meaning, synonyms, calculations, or official board marking rules.'
          : 'Add marking points to calculate a rubric preview. No marks were awarded automatically.',
      };
    });
    setResults(next);
    setResultMethod('scheme');
  }

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
        <button
          className="side-item"
          onClick={() => {
            setQuestions(initialQuestions);
            setResults(null);
            setQuestionAttachments([]);
            setAttachments([]);
            setQuestionPaperText('');
            setAnswerSheetText('');
            setError('');
          }}
        >
          <FileText size={17} /> Start fresh
        </button>
        <div className="sidebar-bottom">
          <ShieldCheck size={18} />
          <span>
            Private by design
            <br />
            <small>Files stay in this draft UI.</small>
          </span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb">
            Workspace <span>/</span> <b>New evaluation</b>
          </div>
          <div className="top-pill">
            <span className="status-dot" /> Ready to check
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
                          <p>Upload your question paper and answer sheet to get question-wise feedback and a clearer picture of what to revise.</p>
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
                  <p>Choose your exam context if useful, then add your answers.</p>
                </div>
              </div>
              <span className="optional">ABOUT THE EXAM</span>
            </div>
            <div className="panel">
              <div className="field-grid">
                <label>
                  Board or curriculum
                  <select
                    value={board}
                    onChange={e => setBoard(e.target.value)}
                  >
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
                  <select
                    value={grade}
                    onChange={e => setGrade(e.target.value)}
                  >
                    <option>Any class</option>
                    {Array.from({ length: 12 }, (_, i) => (
                      <option key={i}>Class {i + 1}</option>
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
                  <p>Add the exam paper so the questions and printed marks are available for reference.</p>
                </div>
              </div>
              <span className="optional">INPUT</span>
            </div>
            <div className="upload-zone">
              <input
                id="question-paper-files"
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md"
                onChange={e => handleFiles(e.target.files, 'question')}
              />
              <label htmlFor="question-paper-files" className="upload-content">
                <div className="upload-icon">
                  <Upload size={22} />
                </div>
                <strong>Choose question paper files</strong>
                <span>Photos, scanned pages, PDFs, or text files</span>
                <small>JPG · PNG · PDF · TXT</small>
              </label>
            </div>
            {questionAttachments.length > 0 && (
              <div className="attachment-list">
                {questionAttachments.map(file => (
                  <div className="attachment" key={file.id}>
                    <div className="file-icon">
                      {file.type.startsWith('image/') ? (
                        <Image size={17} />
                      ) : (
                        <FileText size={17} />
                      )}
                    </div>
                    <div className="file-info">
                      <strong>{file.name}</strong>
                      <span>
                        {file.type || 'File'} · {(file.size / 1024).toFixed(0)}{' '}
                        KB
                      </span>
                      <span className={file.extractedText && !file.extracting && !file.extractionError ? 'extraction-status' : ''}>{file.extracting ? 'Reading text…' : file.extractionError ? 'Text extraction failed' : file.extractedText ? 'Text extracted' : ''}</span>
                    </div>
                    <button
                      aria-label={'Remove question paper ' + file.name}
                      onClick={() =>
                        setQuestionAttachments(prev =>
                          prev.filter(x => x.id !== file.id)
                        )
                      }
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="section-heading">
              <div>
                <span className="step">03</span>
                <div>
                  <h2>Upload your answer sheet</h2>
                  <p>Add photos or a PDF of the answers you wrote.</p>
                </div>
              </div>
              <span className="optional">YOUR WORK</span>
            </div>
            <div className="upload-zone">
              <input
                id="answer-sheet-files"
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md"
                onChange={e => handleFiles(e.target.files, 'answer')}
              />
              <label htmlFor="answer-sheet-files" className="upload-content">
                <div className="upload-icon"><Upload size={22} /></div>
                <strong>Choose answer sheet files</strong>
                <span>Photos, scanned pages, PDFs, or text files</span>
                <small>JPG · PNG · PDF · TXT</small>
              </label>
            </div>
            {attachments.length > 0 && (
              <div className="attachment-list">
                {attachments.map(file => (
                  <div className="attachment" key={file.id}>
                    <div className="file-icon">
                      {file.type.startsWith('image/') ? <Image size={17} /> : <FileText size={17} />}
                    </div>
                    <div className="file-info">
                      <strong>{file.name}</strong>
                      <span>{file.type || 'File'} · {(file.size / 1024).toFixed(0)} KB</span>
                      <span className={file.extractedText && !file.extracting && !file.extractionError ? 'extraction-status' : ''}>{file.extracting ? 'Reading text…' : file.extractionError ? 'Text extraction failed' : file.extractedText ? 'Text extracted' : ''}</span>
                    </div>
                    <button aria-label={'Remove answer sheet ' + file.name} onClick={() => setAttachments(prev => prev.filter(x => x.id !== file.id))}>
                      <X size={16} />
                    </button>
                  </div>
                ))}

              </div>
            )}

            <div className="section-heading answer-heading">
              <div>
                <span className="step">04</span>
                <div>
                  <h2>Enter answers to check</h2>
                  <p>
                    Add your answers below to get feedback.
                  </p>
                </div>
              </div>
              <span className="marks-total">{totalMarks} marks</span>
            </div>
            {questions.map((q, index) => (
              <div className="question-card" key={q.id}>
                <div className="question-top">
                  <span className="q-number">Q{index + 1}</span>
                  <label>
                    Marks for this question
                    <input
                      aria-label={'Maximum marks for question ' + (index + 1)}
                      type="number"
                      min="0"
                      max="100"
                      value={q.marks}
                      onChange={e =>
                        updateQuestion(q.id, 'marks', Number(e.target.value))
                      }
                    />
                  </label>
                </div>
                <label>
                  Question
                  <textarea
                    value={q.prompt}
                    onChange={e =>
                      updateQuestion(q.id, 'prompt', e.target.value)
                    }
                    placeholder="Paste or type the question..."
                    rows={2}
                  />
                </label>
                <label>
                  Your answer
                  <textarea
                    value={q.answer}
                    onChange={e =>
                      updateQuestion(q.id, 'answer', e.target.value)
                    }
                    placeholder="Type your answer as you wrote it..."
                    rows={3}
                  />
                </label>
              </div>
            ))}
            <button className="add-question" onClick={addQuestion}>
              <Plus size={17} /> Add another question
            </button>

            <div className="model-notice">
              <AlertCircle size={18} />
              <div>
                <strong>Automatic marking</strong>
                <p>Printed marks and attempt instructions are read from the uploaded question paper. Review unclear scans and estimated scores.</p>
              </div>
            </div>
            {modelStatus && (
              <div className="model-notice" role="status">
                <Sparkles size={18} />
                <div><strong>AI status</strong><p>{modelStatus}</p></div>
              </div>
            )}
            {error && (
              <div className="error-banner">
                <AlertCircle size={17} />
                <span>{error}</span>
              </div>
            )}
            <button className="evaluate-button" onClick={evaluate} disabled={!!modelStatus}>
              <Sparkles size={18} />
              Run automatic marking{' '}
              <ArrowRight size={18} />
            </button>
          </section>

          <aside className="results-column">
            <div className="results-head">
              <div>
                <span className="step">RESULTS</span>
                <h2>Your evaluation</h2>
              </div>
            </div>
            {results ? (
              <div className="result-panel">
                <div className="score-block">
                  <span>{resultMethod === 'ai' ? 'Estimated score' : 'Marking-point score'}</span>
                  <div>
                    <strong>{awarded}</strong>
                    <span> / {maxAwarded}</span>
                  </div>
                  <div className="score-track">
                    <span
                      style={{
                        width: maxAwarded
                          ? (awarded / maxAwarded) * 100 + '%'
                          : '0%',
                      }}
                    />
                  </div>
                  <small>
                    {maxAwarded ? Math.round((awarded / maxAwarded) * 100) : 0}%
                    · Review before relying on this score
                  </small>
                </div>
                {results.map((r, i) => (
                  <div className="result-question" key={r.id}>
                    <div className="result-q-head">
                      <strong>{r.ref || 'Question ' + (i + 1)}</strong>
                      <b>
                        {r.score} / {r.max}
                      </b>
                    </div>
                    {r.matched.length > 0 && (
                      <p className="good">
                        <CheckCircle2 size={14} /> Matched:{' '}
                        {r.matched.join(', ')}
                      </p>
                    )}
                    {r.missing.length > 0 && (
                      <p className="missing">
                        <AlertCircle size={14} /> Not found:{' '}
                        {r.missing.join(', ')}
                      </p>
                    )}
                    <p className="result-note">{r.note}</p>
                  </div>
                ))}
                <button
                  className="secondary-button"
                  onClick={() => {
                    setResults(null);
                    setError('');
                  }}
                >
                  Edit answers
                </button>
              </div>
            ) : (
              <div className="empty-results">
                <div className="empty-illustration">
                  <ClipboardCheck size={38} />
                  <span>✦</span>
                </div>
                <h3>Your marks will appear here</h3>
                <p>
                  Add a question and answer, then check your results here.
                </p>
                <div className="empty-checks">
                  <span>
                    <CheckCircle2 size={15} /> Question-wise feedback
                  </span>
                  <span>
                    <CheckCircle2 size={15} /> Missing marking points
                  </span>
                  <span>
                    <CheckCircle2 size={15} /> Score summary
                  </span>
                </div>
              </div>
            )}
            <div className="trust-card">
              <ShieldCheck size={19} />
              <div>
                <strong>Designed for transparent marking</strong>
                <p>
                  Every deduction should be explainable. Uncertain answers
                  should be flagged for review, not confidently marked wrong.
                </p>
              </div>
            </div>
            <div className="next-card">
              <div className="next-icon">
                <Sparkles size={17} />
              </div>
              <div>
                <strong>Managed AI mode</strong>
                <p>AI grading runs on the server to avoid large first-use downloads. Photo OCR and scanned-PDF OCR run locally in English and Hindi, one page at a time. Review extracted text and every estimated score.</p>
                <span>Experimental · review all scores</span>
              </div>
            </div>
          </aside>
        </div>
        <footer>
          Paperwise <span>·</span> Independent prototype <span>·</span> Not
          connected to CRAM AI
        </footer>
      </main>
    </div>
  );
}

export default App;
