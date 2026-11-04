import type { ChatFn, ChatMessage } from '../src/ai/provider';

export type ChatCall = { messages: ChatMessage[]; options?: Record<string, unknown> };

export type RefInPrompt = { ref: string; max: number };

/** Read the question blocks the grader actually sends to the model. */
export function refsInPrompt(text: string): RefInPrompt[] {
  const results: RefInPrompt[] = [];
  const pattern = /---\s+(Q[^|\n]+?)\s*\|\s*maximum\s+([\d.]+)\s+marks/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    results.push({ ref: match[1].trim(), max: Number(match[2]) });
  }
  return results;
}

export type MarkDecision = {
  awarded: number;
  feedback?: string;
  correct?: string[];
  missing?: string[];
  mistakes?: string[];
  confidence?: string;
};

/**
 * Deterministic stand-in for the language model. It only answers for the
 * questions actually present in the prompt, mirroring a real grader contract.
 */
export function decisionChat(
  decide: (ref: string, max: number, call: ChatMessage[]) => MarkDecision | null,
  calls: ChatCall[] = []
): ChatFn {
  return async (messages, options) => {
    calls.push({ messages, options: options as Record<string, unknown> });
    const prompt = messages.map(message => message.content).join('\n');
    const refs = refsInPrompt(prompt);
    if (!refs.length) throw new Error('Test chat received no question blocks.');
    const results = refs.map(({ ref, max }) => {
      const decision = decide(ref, max, messages);
      if (!decision) throw new Error(`Test chat has no decision for ${ref}.`);
      return {
        ref,
        awarded: decision.awarded,
        correct_points: decision.correct ?? [],
        missing_points: decision.missing ?? [],
        mistakes: decision.mistakes ?? [],
        feedback: decision.feedback ?? 'Marked against the question requirements.',
        confidence: decision.confidence ?? 'medium',
      };
    });
    return { text: JSON.stringify({ results }), finishReason: 'stop', model: 'test-model' };
  };
}

/** A chat that returns raw strings in sequence (for malformed-reply tests). */
export function sequenceChat(replies: string[], calls: ChatCall[] = []): ChatFn {
  let index = 0;
  return async (messages, options) => {
    calls.push({ messages, options: options as Record<string, unknown> });
    const reply = replies[Math.min(index, replies.length - 1)];
    index++;
    return { text: reply, finishReason: 'stop', model: 'test-model' };
  };
}
