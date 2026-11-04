/** Typed AI failures so the UI can explain what happened without inventing marks. */

export type AiErrorCode =
  | 'unavailable'
  | 'auth'
  | 'timeout'
  | 'rate_limit'
  | 'network'
  | 'provider'
  | 'empty'
  | 'length'
  | 'invalid_output'
  | 'cancelled';

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, code: AiErrorCode, options: { retryable?: boolean; status?: number | null } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}

export function toAiError(value: unknown): AiError {
  if (isAiError(value)) return value;
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : 'The AI request failed.';
  const name = typeof record.name === 'string' ? record.name : '';
  const status = Number(record.status ?? record.statusCode ?? 0) || null;
  const code = typeof record.code === 'string' ? record.code.toLowerCase() : '';

  if (name === 'AbortError' || code === 'abort_error') {
    return new AiError('The AI request was cancelled.', 'cancelled');
  }
  if (code === 'network_error' || /network|fetch failed|failed to fetch|connection/i.test(message)) {
    return new AiError('The connection to the AI service failed.', 'network', { retryable: true });
  }
  if (status === 429 || /rate.?limit|quota/i.test(message)) {
    return new AiError('The AI service is rate-limited right now.', 'rate_limit', { retryable: true, status: 429 });
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|sign[ -]?in|authentication/i.test(message)) {
    return new AiError('The AI service needs you to sign in.', 'auth', { status });
  }
  if ((status !== null && status >= 500) || /unavailable|upstream|overloaded|no provider|model_not_configured/i.test(message)) {
    return new AiError('The AI service is temporarily unavailable.', 'provider', { retryable: true, status });
  }
  return new AiError(message, 'provider', { retryable: true, status });
}

export function friendlyAiMessage(error: unknown): string {
  const aiError = isAiError(error) ? error : toAiError(error);
  switch (aiError.code) {
    case 'auth':
      return 'Paperwise needs you to sign in to the free AI service to mark answers. No score was generated.';
    case 'unavailable':
      return 'The AI service could not load. Check your internet connection, disable any content blocker, and reload Paperwise. No score was generated.';
    case 'timeout':
      return 'The AI service took too long to answer. No score was generated for the affected questions. Try again with fewer pages.';
    case 'rate_limit':
      return 'The free AI service is busy right now. Wait a minute and try again. No score was generated.';
    case 'network':
      return 'The connection to the AI service dropped. Check your internet connection and retry. No score was generated.';
    case 'cancelled':
      return 'Marking was cancelled. No scores were kept.';
    case 'length':
      return 'The AI response hit its output limit. Paperwise retried with smaller batches and still could not finish. No score was invented.';
    case 'invalid_output':
      return 'The AI returned a response Paperwise could not verify. No score was accepted for the affected questions.';
    case 'empty':
      return 'The AI returned an empty response. No score was accepted. Please retry.';
    default:
      return 'AI marking failed. No score was generated. Please retry.';
  }
}
