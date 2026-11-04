import { afterEach, describe, expect, it } from 'vitest';
import { createPuterChat, getPuter } from '../src/ai/provider';
import { AiError } from '../src/ai/errors';

type FakePuter = {
  ai: { chat: (messages: unknown, options: Record<string, unknown>) => Promise<unknown> };
  auth?: { isSignedIn?: () => boolean; signIn?: () => Promise<unknown> };
};

function installPuter(fake: FakePuter | null) {
  (globalThis as unknown as { window?: unknown }).window = fake ? { puter: fake } : {};
}

const PROMPT = [{ role: 'user' as const, content: 'Mark this.' }];

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('Puter provider', () => {
  it('returns normalised message content', async () => {
    installPuter({
      ai: { chat: async () => ({ message: { content: '{"results":[]}' }, finish_reason: 'stop' }) },
    });
    const chat = createPuterChat();
    const result = await chat(PROMPT);
    expect(result.text).toBe('{"results":[]}');
    expect(result.finishReason).toBe('stop');
  });

  it('joins array content blocks', async () => {
    installPuter({
      ai: {
        chat: async () => ({
          message: { content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] },
          finish_reason: 'stop',
        }),
      },
    });
    const result = await createPuterChat()(PROMPT);
    expect(result.text).toBe('part one\npart two');
  });

  it('passes the model and options to Puter', async () => {
    let received: Record<string, unknown> = {};
    installPuter({
      ai: {
        chat: async (_messages, options) => {
          received = options;
          return { message: { content: 'ok' }, finish_reason: 'stop' };
        },
      },
    });
    await createPuterChat({ models: ['deepseek/deepseek-v4.1-flash'] })(PROMPT, { maxTokens: 321, temperature: 0.2 });
    expect(received.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(received.max_tokens).toBe(321);
    expect(received.temperature).toBe(0.2);
    expect(received.normalize).toBe(true);
  });

  it('reports a clear error when the library did not load', async () => {
    installPuter(null);
    expect(getPuter()).toBeNull();
    await expect(createPuterChat()(PROMPT)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('requires sign-in when Puter reports a signed-out user', async () => {
    installPuter({
      ai: { chat: async () => ({ message: { content: 'ok' }, finish_reason: 'stop' }) },
      auth: {
        isSignedIn: () => false,
        signIn: async () => {
          throw new Error('popup blocked');
        },
      },
    });
    await expect(createPuterChat()(PROMPT)).rejects.toMatchObject({ code: 'auth' });
  });

  it('maps a truncated reply to a length error', async () => {
    installPuter({
      ai: { chat: async () => ({ message: { content: '' }, finish_reason: 'length' }) },
    });
    await expect(createPuterChat()(PROMPT)).rejects.toMatchObject({ code: 'length' });
  });

  it('falls back to the next model when the first one fails', async () => {
    const seen: string[] = [];
    installPuter({
      ai: {
        chat: async (_messages, options) => {
          const model = String(options.model);
          seen.push(model);
          if (model === 'deepseek/deepseek-v4.1-flash') {
            throw Object.assign(new Error('upstream_provider_unavailable'), { status: 503 });
          }
          return { message: { content: 'fallback ok' }, finish_reason: 'stop' };
        },
      },
    });
    const result = await createPuterChat({ retries: 0 })(PROMPT);
    expect(result.text).toBe('fallback ok');
    expect(result.model).toBe('deepseek/deepseek-v4-flash');
    expect(seen).toEqual(['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash']);
  });

  it('times out instead of waiting forever', async () => {
    installPuter({
      ai: {
        chat: async () => {
          await new Promise(resolve => setTimeout(resolve, 80));
          return { message: { content: 'too late' }, finish_reason: 'stop' };
        },
      },
    });
    await expect(
      createPuterChat({ retries: 0 })(PROMPT, { timeoutMs: 10 })
    ).rejects.toBeInstanceOf(AiError);
  });

  it('does not retry an authentication failure', async () => {
    let calls = 0;
    installPuter({
      ai: {
        chat: async () => {
          calls++;
          throw Object.assign(new Error('unauthorized'), { status: 401 });
        },
      },
    });
    await expect(createPuterChat({ retries: 2 })(PROMPT)).rejects.toMatchObject({ code: 'auth' });
    expect(calls).toBe(1);
  });
});
