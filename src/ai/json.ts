/** Tolerant, verifiable JSON handling for model output. */

import { AiError } from './errors';

/**
 * Extract the first balanced JSON object from a model reply. Handles code
 * fences, leading prose, and braces inside strings.
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AiError('The AI returned an empty response.', 'empty');
  }
  const text = raw
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '');

  // A grading reply must be an object. An array of results is a different
  // contract, so reject it rather than silently reading its first element.
  if (text.trimStart().startsWith('[')) {
    throw new AiError('The AI returned a list instead of a JSON object.', 'invalid_output');
  }

  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            const parsed: unknown = JSON.parse(candidate);
            if (isRecord(parsed)) return parsed;
          } catch {
            // Try the next opening brace; a model may echo prose with braces.
          }
          break;
        }
      }
    }
  }
  throw new AiError('The AI response did not contain valid JSON.', 'invalid_output');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a finite number from a number or a plain numeric string. */
export function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

export function readText(value: unknown, maxLength = 600): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** Read a bounded list of short strings, dropping empty entries. */
export function readTextList(value: unknown, maxItems = 6, maxLength = 220): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = readText(item, maxLength);
    if (text.length >= 2 && !result.includes(text)) result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

export function readConfidence(value: unknown): 'high' | 'medium' | 'low' | null {
  if (typeof value !== 'string') return null;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'high' || normalised === 'medium' || normalised === 'low') return normalised;
  return null;
}
