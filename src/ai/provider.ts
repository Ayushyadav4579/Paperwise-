import { AiError, toAiError } from './errors';

/**
 * Puter.js provider.
 *
 * Puter exposes DeepSeek models without an API key or a paid OpenAI/Gemini
 * account: the signed-in user's Puter account covers the request. The model id
 * and option names below follow the documented Puter API
 * (https://docs.puter.com/AI/chat/).
 */

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ChatResult = { text: string; finishReason: string; model: string };

export type ChatFn = (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult>;

type PuterResponse = {
  message?: { content?: unknown };
  finish_reason?: string;
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
  text?: string;
};

type PuterAI = {
  chat: (messages: ChatMessage[], options: Record<string, unknown>) => Promise<PuterResponse>;
};

type PuterAuth = {
  isSignedIn?: () => boolean;
  signIn?: () => Promise<unknown>;
};

type PuterGlobal = { ai?: PuterAI; auth?: PuterAuth };

declare global {
  interface Window {
    puter?: PuterGlobal;
  }
}

export const PROVIDER_LABEL = 'Puter.js';
// Checked against Puter's live model catalogue (api.puter.com/puterai/chat/models)
// on 2026-11-06. It lists provider-prefixed routes such as
// openrouter:deepseek/deepseek-v4.1-flash alongside the bare id used in the
// documentation, so the fallbacks are those concrete routes.
export const DEFAULT_MODELS = [
  'deepseek/deepseek-v4.1-flash',
  'openrouter:deepseek/deepseek-v4.1-flash',
  'infron:deepseek/deepseek-v4.1-flash',
];
export const PRIMARY_MODEL = DEFAULT_MODELS[0];

const DEFAULT_TIMEOUT_MS = 150_000;
const REQUEST_RETRIES = 1;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiError('Marking was cancelled.', 'cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiError('Marking was cancelled.', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function getPuter(): PuterGlobal | null {
  if (typeof window === 'undefined') return null;
  return window.puter ?? null;
}

/**
 * The SDK is a plain CDN script. On a slow phone connection it can still be
 * loading when marking starts, so wait for it briefly instead of reporting
 * "AI service could not be loaded" on a connection that is merely slow.
 */
async function waitForPuter(timeoutMs = 4000): Promise<PuterGlobal | null> {
  let puter = getPuter();
  if (puter?.ai?.chat) return puter;
  if (typeof document === 'undefined') return puter;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 120));
    puter = getPuter();
    if (puter?.ai?.chat) return puter;
  }
  return puter;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return '';
}

async function ensureSignedIn(puter: PuterGlobal): Promise<void> {
  const auth = puter.auth;
  if (!auth?.isSignedIn) return;
  let signedIn = false;
  try {
    signedIn = auth.isSignedIn();
  } catch {
    return;
  }
  if (signedIn) return;
  if (!auth.signIn) {
    throw new AiError('Sign in to the free AI service to mark answers.', 'auth');
  }
  try {
    await auth.signIn();
  } catch {
    throw new AiError('Sign in to the free AI service to mark answers.', 'auth');
  }
}

async function callPuter(
  puter: PuterGlobal,
  messages: ChatMessage[],
  model: string,
  options: ChatOptions
): Promise<ChatResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const external = options.signal;
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await puter.ai!.chat(messages, {
      model,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 1200,
      normalize: true,
      fallback: true,
      signal: controller.signal,
    });

    if (external?.aborted) throw new AiError('Marking was cancelled.', 'cancelled');
    if (timedOut) {
      throw new AiError('The AI request timed out.', 'timeout', { retryable: true });
    }

    const content = response?.message?.content ?? response?.choices?.[0]?.message?.content ?? response?.text;
    const text = contentToText(content);
    const finishReason = String(
      response?.finish_reason ?? response?.choices?.[0]?.finish_reason ?? 'stop'
    ).toLowerCase();

    if (!text.trim()) {
      if (finishReason === 'length' || finishReason === 'max_tokens') {
        throw new AiError('The AI response was cut off before any content was returned.', 'length');
      }
      throw new AiError('The AI returned an empty response.', 'empty', { retryable: true });
    }
    return { text, finishReason, model };
  } catch (error) {
    if (external?.aborted) throw new AiError('Marking was cancelled.', 'cancelled');
    if (timedOut) throw new AiError('The AI request timed out.', 'timeout', { retryable: true });
    throw toAiError(error);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}

/**
 * Create a chat function backed by Puter.js. Transient failures are retried
 * once per model, then the next DeepSeek model is tried. A real failure is
 * reported; no response is fabricated.
 */
export function createPuterChat(config: { models?: string[]; retries?: number } = {}): ChatFn {
  const models = config.models?.length ? config.models : DEFAULT_MODELS;
  const retries = config.retries ?? REQUEST_RETRIES;

  return async (messages, options = {}) => {
    const puter = await waitForPuter();
    if (!puter?.ai?.chat) {
      throw new AiError(
        'The AI service could not be loaded. Reload Paperwise with a working internet connection.',
        'unavailable'
      );
    }
    if (options.signal?.aborted) throw new AiError('Marking was cancelled.', 'cancelled');
    await ensureSignedIn(puter);

    let lastError: AiError | null = null;
    for (const model of models) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (options.signal?.aborted) throw new AiError('Marking was cancelled.', 'cancelled');
        try {
          return await callPuter(puter, messages, model, options);
        } catch (error) {
          const aiError = toAiError(error);
          lastError = aiError;
          if (!aiError.retryable) throw aiError;
          if (attempt < retries) await delay(800 * (attempt + 1), options.signal);
        }
      }
    }
    throw lastError ?? new AiError('The AI service did not answer.', 'provider');
  };
}
