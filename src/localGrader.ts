type GradeQuestion = {
  id: number;
  prompt: string;
  answer: string;
  marks: number;
  criteria: string;
};

export type LocalGradeResult = {
  id: number;
  score: number;
  max: number;
  rationale: string;
};

type Generator = (
  messages: Array<{ role: string; content: string }>,
  options: Record<string, unknown>
) => Promise<Array<{ generated_text: string | Array<{ role?: string; content?: string }> }>>;

const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';
let modelPromise: Promise<Generator> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function reportProgress(onStatus: (message: string) => void, info: {
  status?: string;
  progress?: number;
  file?: string;
  name?: string;
}) {
  if (info.status === 'progress' && typeof info.progress === 'number') {
    const raw = info.progress <= 1 ? info.progress * 100 : info.progress;
    const percent = Math.max(0, Math.min(100, Math.round(raw)));
    const file = (info.file || info.name || '').toLowerCase();
    if (file.includes('onnx') || file.includes('model')) {
      onStatus('Downloading model weights: ' + percent + '%. Keep Paperwise open on Wi-Fi; the first download can be large.');
    } else {
      onStatus('Preparing tokenizer and model files…');
    }
  } else if (info.status === 'initiate') {
    onStatus('Preparing the local model download…');
  } else if (info.status === 'done') {
    onStatus('Model files ready; initializing local inference…');
  }
}

async function getGenerator(onStatus: (message: string) => void): Promise<Generator> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      let supportsWebGPU = false;
      try {
        supportsWebGPU = typeof navigator !== 'undefined' &&
          'gpu' in navigator &&
          !!(await withTimeout(
            (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu!.requestAdapter(),
            8000,
            'WebGPU adapter check timed out'
          ));
      } catch {
        supportsWebGPU = false;
      }
      const progress_callback = (info: {
        status?: string;
        progress?: number;
        file?: string;
        name?: string;
      }) => reportProgress(onStatus, info);
      onStatus(supportsWebGPU
        ? 'WebGPU is available. Loading Qwen2.5-0.5B-Instruct…'
        : 'Using CPU/WASM mode. This may be slow on a phone; loading model files…');
      try {
        return await withTimeout(
          pipeline('text-generation', MODEL_ID, {
            device: supportsWebGPU ? 'webgpu' : 'wasm',
            dtype: supportsWebGPU ? 'q4f16' : 'q4',
            progress_callback,
          }) as unknown as Promise<Generator>,
          180000,
          'Model loading exceeded 3 minutes. The phone/browser may not have enough memory or the model download may be blocked.'
        );
      } catch (firstError) {
        if (!supportsWebGPU) throw firstError;
        onStatus('WebGPU initialization failed; retrying once with CPU/WASM…');
        return await withTimeout(
          pipeline('text-generation', MODEL_ID, {
            device: 'wasm',
            dtype: 'q4',
            progress_callback,
          }) as unknown as Promise<Generator>,
          180000,
          'CPU/WASM model loading exceeded 3 minutes. Check Wi-Fi and available phone memory.'
        );
      }
    })().catch(error => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

function extractAssistantText(output: Array<{ generated_text: string | Array<{ role?: string; content?: string }> }>): string {
  const generated = output?.[0]?.generated_text;
  if (typeof generated === 'string') return generated.trim();
  if (Array.isArray(generated)) {
    for (let i = generated.length - 1; i >= 0; i--) {
      if (generated[i]?.role === 'assistant' && typeof generated[i]?.content === 'string') {
        return generated[i].content.trim();
      }
    }
    const last = generated[generated.length - 1];
    return typeof last?.content === 'string' ? last.content.trim() : '';
  }
  return '';
}

export async function gradeLocally(
  questions: GradeQuestion[],
  board: string,
  grade: string,
  onStatus: (message: string) => void
): Promise<LocalGradeResult[]> {
  if (!questions.length || questions.length > 30) {
    throw new Error('LOCAL_MODEL: Submit between 1 and 30 questions for local marking.');
  }
  if (!('indexedDB' in globalThis)) {
    throw new Error('LOCAL_MODEL: This browser does not support the storage required for local model caching. Try a recent version of Chrome.');
  }

  try {
    const generator = await getGenerator(onStatus);
    const results: LocalGradeResult[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      onStatus('Marking question ' + (i + 1) + ' of ' + questions.length + ' with the local open-weight model…');
      const system = [
        'You are a cautious school exam marker. Judge only the supplied question, student answer, maximum marks, and marking points.',
        'Accept equivalent correct wording. Award partial marks for relevant correct content. Never exceed maximum marks.',
        'Return exactly one compact JSON object and nothing else. Do not repeat the question or input. Use score as a JSON number from 0 to the maximum marks, and rationale as a short string.',
        'The JSON keys must be score and rationale. The score must be a number, not a sentence or percentage. Example format only: {"score":2,"rationale":"Names the process and its purpose."}',
      ].join(' ');
      const user = JSON.stringify({
        board,
        class_level: grade,
        question: q.prompt,
        student_answer: q.answer,
        maximum_marks: q.marks,
        marking_points: q.criteria || '(not supplied; infer a basic rubric and be cautious)',
      });
      const output = await withTimeout(
        generator([
          { role: 'system', content: system },
          { role: 'user', content: user },
        ], { max_new_tokens: 180, do_sample: false, return_full_text: false }),
        90000,
        'Local model inference exceeded 90 seconds on question ' + (i + 1) + '. This phone/browser may be too slow for this model. No score was accepted; retry once or use a smaller model/device.'
      );
      const raw = extractAssistantText(output).trim();
      // Some Transformers.js pipelines return the entire prompt plus completion by default.
      // Explicitly disable that above, and parse only the generated completion here.
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start < 0 || end <= start) {
        throw new Error('The local model did not return valid JSON for question ' + (i + 1) + '. No scores were accepted. Model output: ' + raw.slice(0, 180));
      }
      let parsed: { score?: number | string; rationale?: string; explanation?: string; marks?: number | string; awarded_marks?: number | string; marks_awarded?: number | string };
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        throw new Error('The local model returned malformed JSON for question ' + (i + 1) + '. No scores were accepted. Model output: ' + raw.slice(start, Math.min(end + 1, start + 180)));
      }
      // Small models sometimes serialize numeric fields as strings or use "marks"/"explanation".
      // Accept only an explicit finite score within the question's real maximum.
      const scoreValue = parsed.score ?? parsed.marks ?? parsed.awarded_marks ?? parsed.marks_awarded;
      const scoreText = typeof scoreValue === 'string' ? scoreValue.trim() : '';
      const fractionMatch = scoreText.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
      const explicitMarkMatch = scoreText.match(/^(\d+(?:\.\d+)?)(?:\s*(?:marks?|points?))?$/i);
      const score = typeof scoreValue === 'number' ? scoreValue :
        fractionMatch && Number(fractionMatch[2]) > 0
          ? Number(fractionMatch[1]) * q.marks / Number(fractionMatch[2])
          : explicitMarkMatch ? Number(explicitMarkMatch[1]) : NaN;
      if (!Number.isFinite(score) || score < 0 || score > q.marks) {
        throw new Error('The local model returned no usable score between 0 and ' + q.marks + ' for question ' + (i + 1) + '. No scores were accepted. Model output: ' + raw.slice(start, Math.min(end + 1, start + 180)));
      }
      const rationale = typeof parsed.rationale === 'string' && parsed.rationale.trim()
        ? parsed.rationale.trim()
        : typeof parsed.explanation === 'string' && parsed.explanation.trim()
          ? parsed.explanation.trim()
          : 'The model returned a numeric score but no explanation. Review this experimental mark manually.';
      results.push({
        id: q.id,
        score: Math.round(score * 2) / 2,
        max: q.marks,
        rationale,
      });
    }
    return results;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('LOCAL_MODEL: ')) throw error;
    const message = error instanceof Error ? error.message : 'Unknown local model error';
    throw new Error('LOCAL_MODEL: The on-device model could not run: ' + message + ' No AI scores were generated. Try a modern browser with more free memory, or use a configured self-hosted model endpoint.');
  }
}
