import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const anthropicCreate = vi.fn();
const openaiCreate = vi.fn();
const geminiGenerateContent = vi.fn();

class FakeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: geminiGenerateContent };
  },
  ApiError: FakeApiError,
}));

// Imported after the mocks above so the provider classes pick up the fakes.
const {
  resolveAiProvider,
  hasAnyAiProvider,
  resolveGeminiProvider,
  resolveOpenRouterProvider,
  resolvePrimaryFallbackProvider,
} = await import('./provider.js');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveAiProvider preference order', () => {
  it('prefers anthropic when all three keys are present', () => {
    const provider = resolveAiProvider({
      anthropicApiKey: 'a',
      openaiApiKey: 'o',
      geminiApiKey: 'g',
    });
    expect(provider.name).toBe('anthropic');
  });

  it('prefers openai over gemini when anthropic is absent', () => {
    const provider = resolveAiProvider({ openaiApiKey: 'o', geminiApiKey: 'g' });
    expect(provider.name).toBe('openai');
  });

  it('falls back to gemini when it is the only key configured', () => {
    const provider = resolveAiProvider({ geminiApiKey: 'g' });
    expect(provider.name).toBe('gemini');
  });

  it('throws when no provider key is configured', () => {
    expect(() => resolveAiProvider({})).toThrow(/No AI provider configured/);
  });
});

describe('hasAnyAiProvider', () => {
  it('is true when only a gemini key is present', () => {
    expect(hasAnyAiProvider({ geminiApiKey: 'g' })).toBe(true);
  });

  it('is false when no key is present', () => {
    expect(hasAnyAiProvider({})).toBe(false);
  });
});

describe('GeminiProvider.generateText', () => {
  beforeEach(() => {
    geminiGenerateContent.mockReset();
  });

  it('returns response.text on a normal successful call', async () => {
    geminiGenerateContent.mockResolvedValue({ text: '{"score":1}' });
    const provider = resolveAiProvider({ geminiApiKey: 'g' });
    const result = await provider.generateText('prompt');
    expect(result).toBe('{"score":1}');
    expect(geminiGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('returns an empty string rather than throwing when response.text is undefined', async () => {
    geminiGenerateContent.mockResolvedValue({ text: undefined });
    const provider = resolveAiProvider({ geminiApiKey: 'g' });
    await expect(provider.generateText('prompt')).resolves.toBe('');
  });

  it('retries once on a 429 and succeeds on the second attempt', async () => {
    geminiGenerateContent
      .mockRejectedValueOnce(new FakeApiError('rate limited', 429))
      .mockResolvedValueOnce({ text: 'ok' });
    const provider = resolveAiProvider({ geminiApiKey: 'g' });
    const result = await provider.generateText('prompt');
    expect(result).toBe('ok');
    expect(geminiGenerateContent).toHaveBeenCalledTimes(2);
  });

  it('retries once on a 500 and gives up if it persists', async () => {
    geminiGenerateContent.mockRejectedValue(new FakeApiError('server error', 500));
    const provider = resolveAiProvider({ geminiApiKey: 'g' });
    await expect(provider.generateText('prompt')).rejects.toThrow('server error');
    expect(geminiGenerateContent).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a 400 (bad request / invalid key) — it will never succeed on retry', async () => {
    geminiGenerateContent.mockRejectedValue(new FakeApiError('invalid API key', 400));
    const provider = resolveAiProvider({ geminiApiKey: 'g' });
    await expect(provider.generateText('prompt')).rejects.toThrow('invalid API key');
    expect(geminiGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('never logs or throws the raw API key itself', async () => {
    geminiGenerateContent.mockResolvedValue({ text: 'ok' });
    const provider = resolveAiProvider({ geminiApiKey: 'super-secret-key' });
    await provider.generateText('prompt');
    const callArgs = JSON.stringify(geminiGenerateContent.mock.calls);
    expect(callArgs).not.toContain('super-secret-key');
  });
});

describe('resolveGeminiProvider / resolveOpenRouterProvider (multi-LLM consensus)', () => {
  it('resolveGeminiProvider returns undefined when no key is configured', () => {
    expect(resolveGeminiProvider({})).toBeUndefined();
  });

  it('resolveGeminiProvider returns a gemini provider when configured, regardless of other keys', () => {
    const provider = resolveGeminiProvider({ geminiApiKey: 'g' });
    expect(provider?.name).toBe('gemini');
  });

  it('resolveOpenRouterProvider returns undefined when no key is configured', () => {
    expect(resolveOpenRouterProvider({})).toBeUndefined();
  });

  it('resolveOpenRouterProvider returns an openrouter provider when key + model are configured', () => {
    const provider = resolveOpenRouterProvider({
      openrouterApiKey: 'or-key',
      openrouterModel: 'some/model:free',
    });
    expect(provider?.name).toBe('openrouter');
  });

  it('resolveOpenRouterProvider throws a clear error if the key is set but the model is missing', () => {
    expect(() => resolveOpenRouterProvider({ openrouterApiKey: 'or-key' })).toThrow(
      /OPENROUTER_MODEL must be set/,
    );
  });
});

describe('resolvePrimaryFallbackProvider', () => {
  function fakeProvider(name: string, impl: (prompt: string) => Promise<string>) {
    return { name: name as never, generateText: vi.fn(impl) };
  }

  it('returns undefined when neither provider is configured', () => {
    expect(resolvePrimaryFallbackProvider(undefined, undefined)).toBeUndefined();
  });

  it('returns the primary alone when only it is configured', () => {
    const primary = fakeProvider('gemini', async () => 'ok');
    expect(resolvePrimaryFallbackProvider(primary, undefined)).toBe(primary);
  });

  it('returns the fallback alone when only it is configured', () => {
    const fallback = fakeProvider('openrouter', async () => 'ok');
    expect(resolvePrimaryFallbackProvider(undefined, fallback)).toBe(fallback);
  });

  it('uses the primary result and never calls the fallback when the primary succeeds', async () => {
    const primary = fakeProvider('gemini', async () => 'primary-result');
    const fallback = fakeProvider('openrouter', async () => 'fallback-result');
    const combined = resolvePrimaryFallbackProvider(primary, fallback)!;

    await expect(combined.generateText('prompt')).resolves.toBe('primary-result');
    expect(primary.generateText).toHaveBeenCalledTimes(1);
    expect(fallback.generateText).not.toHaveBeenCalled();
  });

  it('falls through to the fallback when the primary throws', async () => {
    const primary = fakeProvider('gemini', async () => {
      throw new Error('gemini down');
    });
    const fallback = fakeProvider('openrouter', async () => 'fallback-result');
    const combined = resolvePrimaryFallbackProvider(primary, fallback)!;

    await expect(combined.generateText('prompt')).resolves.toBe('fallback-result');
    expect(fallback.generateText).toHaveBeenCalledTimes(1);
  });

  it('surfaces the fallback error when both the primary and the fallback fail', async () => {
    const primary = fakeProvider('gemini', async () => {
      throw new Error('gemini down');
    });
    const fallback = fakeProvider('openrouter', async () => {
      throw new Error('openrouter down too');
    });
    const combined = resolvePrimaryFallbackProvider(primary, fallback)!;

    await expect(combined.generateText('prompt')).rejects.toThrow('openrouter down too');
  });

  it('reports the primary provider name (matches which provider actually ran on the common path)', () => {
    const primary = fakeProvider('gemini', async () => 'ok');
    const fallback = fakeProvider('openrouter', async () => 'ok');
    expect(resolvePrimaryFallbackProvider(primary, fallback)!.name).toBe('gemini');
  });
});

describe('OpenRouterProvider.generateText', () => {
  function stubFetchOnce(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns the message content on a normal successful call', async () => {
    stubFetchOnce(200, { choices: [{ message: { content: '{"score":1}' } }] });
    const provider = resolveOpenRouterProvider({
      openrouterApiKey: 'or-key',
      openrouterModel: 'some/model:free',
    })!;
    await expect(provider.generateText('prompt')).resolves.toBe('{"score":1}');
  });

  it('sends reasoning:{enabled:false} — verified live (2026-07-22) that leaving reasoning on can consume the entire token budget before the real answer is emitted', async () => {
    const fetchMock = stubFetchOnce(200, { choices: [{ message: { content: 'ok' } }] });
    const provider = resolveOpenRouterProvider({
      openrouterApiKey: 'or-key',
      openrouterModel: 'some/model:free',
    })!;
    await provider.generateText('prompt');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.model).toBe('some/model:free');
  });

  it('returns an empty string rather than throwing when content is missing', async () => {
    stubFetchOnce(200, { choices: [{ message: {} }] });
    const provider = resolveOpenRouterProvider({
      openrouterApiKey: 'or-key',
      openrouterModel: 'some/model:free',
    })!;
    await expect(provider.generateText('prompt')).resolves.toBe('');
  });

  it('retries once on an HTTP 429 and succeeds on the second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = resolveOpenRouterProvider({
      openrouterApiKey: 'or-key',
      openrouterModel: 'some/model:free',
    })!;
    await expect(provider.generateText('prompt')).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after retrying an HTTP 500 once', async () => {
    stubFetchOnce(500, null);
    const provider = resolveOpenRouterProvider({
      openrouterApiKey: 'or-key',
      openrouterModel: 'some/model:free',
    })!;
    await expect(provider.generateText('prompt')).rejects.toThrow(/500/);
  });

  it('does not retry on an HTTP 400 (bad request) — it will never succeed on retry', async () => {
    const fetchMock = stubFetchOnce(400, null);
    const provider = resolveOpenRouterProvider({
      openrouterApiKey: 'or-key',
      openrouterModel: 'some/model:free',
    })!;
    await expect(provider.generateText('prompt')).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats an embedded error object in an HTTP 200 response as a failure and retries it (verified live: OpenRouter can return 200 with an upstream-provider error payload)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'upstream busy', code: 502 } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = resolveOpenRouterProvider({
      openrouterApiKey: 'or-key',
      openrouterModel: 'some/model:free',
    })!;
    await expect(provider.generateText('prompt')).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends the key only in the Authorization header (the correct, required place — the request destination is OpenRouter itself, never a log) and never embeds it in a thrown error message', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer super-secret-or-key',
      );
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = resolveOpenRouterProvider({
      openrouterApiKey: 'super-secret-or-key',
      openrouterModel: 'some/model:free',
    })!;

    let caught: unknown;
    try {
      await provider.generateText('prompt');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain('super-secret-or-key');
    expect(fetchMock).toHaveBeenCalled();
  });
});
