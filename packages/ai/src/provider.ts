import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ApiError, GoogleGenAI } from '@google/genai';

export type AiProviderName = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'ollama';

export interface GenerateOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiProvider {
  readonly name: AiProviderName;
  generateText(prompt: string, options?: GenerateOptions): Promise<string>;
}

const ANTHROPIC_MODEL = 'claude-sonnet-5';
const OPENAI_MODEL = 'gpt-4.1';
const GEMINI_MODEL = 'gemini-2.5-flash';

class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateText(prompt: string, options?: GenerateOptions): Promise<string> {
    const response = await this.client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      system: options?.system,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = response.content[0];
    return block?.type === 'text' ? block.text : '';
  }
}

class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async generateText(prompt: string, options?: GenerateOptions): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      messages: [
        ...(options?.system ? [{ role: 'system' as const, content: options.system }] : []),
        { role: 'user' as const, content: prompt },
      ],
    });
    return response.choices[0]?.message?.content ?? '';
  }
}

const GEMINI_TIMEOUT_MS = 15_000;
/** 1 retry (2 total attempts) — only on transient failures (timeout/429/5xx), never on
 * an auth/bad-request error, which will never succeed on retry and would just add
 * latency to a launch that's going to fail closed anyway (see riskScorer.ts). */
const GEMINI_MAX_ATTEMPTS = 2;

function isRetryableGeminiError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500;
  // Timeouts / aborts / network errors surface as a plain Error (or DOMException-like
  // AbortError) rather than an ApiError — worth one retry, unlike a 4xx.
  return true;
}

class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateText(prompt: string, options?: GenerateOptions): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            systemInstruction: options?.system,
            maxOutputTokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
            httpOptions: { timeout: GEMINI_TIMEOUT_MS },
            // gemini-2.5-flash reasons internally by default and bills/counts that
            // reasoning against maxOutputTokens — with a small budget (riskScorer.ts
            // uses 300) that silently ate the entire response before any of the
            // actual answer was emitted, truncating valid JSON mid-object. This is a
            // scoring call with a short, fully-specified output shape, not an
            // open-ended reasoning task, so the thinking step buys nothing here.
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        return response.text ?? '';
      } catch (err) {
        lastError = err;
        if (attempt >= GEMINI_MAX_ATTEMPTS || !isRetryableGeminiError(err)) break;
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Gemini request failed');
  }
}

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_TIMEOUT_MS = 15_000;
/** Same rationale as GEMINI_MAX_ATTEMPTS above — one retry, transient failures only. */
const OPENROUTER_MAX_ATTEMPTS = 2;

/** Thrown for both an HTTP-level error and the embedded-error-in-a-200-response
 * shape OpenRouter uses for upstream provider failures (see class doc comment). */
class OpenRouterApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function isRetryableOpenRouterError(err: unknown): boolean {
  if (err instanceof OpenRouterApiError) return err.status === 429 || err.status >= 500;
  // Timeouts / aborts / network errors — worth one retry, same as Gemini.
  return true;
}

interface OpenRouterResponseBody {
  choices?: { message?: { content?: string } }[];
  // Verified live (2026-07-22 account smoke test): OpenRouter can return HTTP 200
  // with an embedded error object for an upstream-provider-side failure (observed:
  // "Upstream error from Nvidia: ResourceExhausted: Worker local total request
  // limit reached", code 502) — checking only `res.ok` would silently treat that
  // as a successful empty response instead of the transient failure it is.
  error?: { message?: string; code?: number };
}

class OpenRouterProvider implements AiProvider {
  readonly name = 'openrouter' as const;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generateText(prompt: string, options?: GenerateOptions): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= OPENROUTER_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            // Never logged — only ever placed in this request header.
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              ...(options?.system ? [{ role: 'system', content: options.system }] : []),
              { role: 'user', content: prompt },
            ],
            max_tokens: options?.maxTokens ?? 1024,
            temperature: options?.temperature ?? 0.7,
            // Verified live (2026-07-22 account smoke test): the configured model
            // reasons internally by default, same failure mode GEMINI_MODEL's
            // thinkingConfig above already works around — with reasoning left on,
            // a short maxTokens budget (riskScorer.ts uses 300) was entirely
            // consumed by the reasoning trace, truncating the actual JSON answer
            // before it was ever emitted. OpenRouter's own unified `reasoning`
            // request field turns this off across whichever backend actually
            // serves the configured model.
            reasoning: { enabled: false },
          }),
          signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
        });

        if (!res.ok) {
          throw new OpenRouterApiError(`OpenRouter request failed: ${res.status}`, res.status);
        }
        const data = (await res.json()) as OpenRouterResponseBody;
        if (data.error) {
          throw new OpenRouterApiError(
            `OpenRouter upstream error: ${data.error.message ?? 'unknown'}`,
            data.error.code ?? 502,
          );
        }
        return data.choices?.[0]?.message?.content ?? '';
      } catch (err) {
        lastError = err;
        if (attempt >= OPENROUTER_MAX_ATTEMPTS || !isRetryableOpenRouterError(err)) break;
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('OpenRouter request failed');
  }
}

/**
 * Self-hosted Ollama (2026-07-26): a third, best-effort consensus vote
 * alongside Gemini/OpenRouter (see consensus.ts's `ollama` parameter) —
 * "best-effort" because unlike those two, an Ollama failure/timeout must
 * never force a SKIP; the caller degrades to today's two-provider gate
 * instead. 45s timeout (vs. Gemini/OpenRouter's 15s) because this hits a
 * self-hosted box with no SLA and no cold-start guarantee — a live probe
 * against phi4:14.7B here measured ~8s just to load the model into memory
 * before a single token was generated. No retry: a second attempt at up to
 * 45s more would dominate the parallel Promise.all this runs inside of for
 * comparatively little benefit — a timeout just excludes this vote for that
 * one token, which is the intended fail-open behavior anyway.
 */
const OLLAMA_TIMEOUT_MS = 45_000;

interface OllamaGenerateResponseBody {
  response?: string;
  error?: string;
}

export class OllamaProvider implements AiProvider {
  readonly name = 'ollama' as const;

  constructor(
    private readonly host: string,
    private readonly model: string,
  ) {}

  async generateText(prompt: string, options?: GenerateOptions): Promise<string> {
    const res = await fetch(`${this.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        system: options?.system,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.7,
          num_predict: options?.maxTokens ?? 1024,
        },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as OllamaGenerateResponseBody;
    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }
    return data.response ?? '';
  }
}

export interface AiProviderKeys {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  openrouterApiKey?: string;
  /** Required whenever openrouterApiKey is set — see resolveOpenRouterProvider.
   * Deliberately has no fallback/auto-substitution: a misconfigured or
   * unavailable model fails the request, which the caller (riskScorer.ts's
   * scoreToken) already treats as a fail-closed SKIP, never a silent switch
   * to some other model. */
  openrouterModel?: string;
}

/** Prefers Claude, then GPT, when more than one key is present; falls back to
 * whichever one exists. Not used by the trading pipeline (apps/api) — see
 * worker.ts, which deliberately never passes geminiApiKey here and gets its
 * scoring exclusively from OpenRouter/Ollama via evaluateMultiLlmConsensus
 * instead. Gemini is intentionally excluded from this priority chain (unlike
 * resolveGeminiProvider below, which apps/marketing-engine still uses
 * directly for its own, non-trading content/image generation). */
export function resolveAiProvider(keys: AiProviderKeys): AiProvider {
  if (keys.anthropicApiKey) return new AnthropicProvider(keys.anthropicApiKey);
  if (keys.openaiApiKey) return new OpenAiProvider(keys.openaiApiKey);
  throw new Error(
    'No AI provider configured: set ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment.',
  );
}

export function hasAnyAiProvider(keys: AiProviderKeys): boolean {
  return Boolean(keys.anthropicApiKey || keys.openaiApiKey);
}

/**
 * Used directly by apps/marketing-engine (content + image generation) —
 * bypasses resolveAiProvider's priority chain entirely, since that chain no
 * longer considers Gemini at all. NOT used anywhere in the trading pipeline
 * (apps/api) — see worker.ts and packages/ai/src/consensus.ts, whose
 * multi-LLM consensus gate is OpenRouter + Ollama only.
 */
export function resolveGeminiProvider(
  keys: Pick<AiProviderKeys, 'geminiApiKey'>,
): AiProvider | undefined {
  return keys.geminiApiKey ? new GeminiProvider(keys.geminiApiKey) : undefined;
}

export function resolveOpenRouterProvider(
  keys: Pick<AiProviderKeys, 'openrouterApiKey' | 'openrouterModel'>,
): AiProvider | undefined {
  if (!keys.openrouterApiKey) return undefined;
  if (!keys.openrouterModel) {
    throw new Error('OPENROUTER_MODEL must be set when OPENROUTER_API_KEY is configured.');
  }
  return new OpenRouterProvider(keys.openrouterApiKey, keys.openrouterModel);
}

export interface OllamaProviderConfig {
  ollamaHost?: string;
  ollamaModel?: string;
}

/**
 * No API key — a host URL + model name instead, same optional-third-voter
 * role resolveGeminiProvider/resolveOpenRouterProvider fill for consensus
 * mode (see consensus.ts). Returns undefined (not an error) when unconfigured,
 * same convention as those two, so the caller degrades to the existing
 * two-provider consensus with zero special-casing.
 */
export function resolveOllamaProvider(keys: OllamaProviderConfig): AiProvider | undefined {
  if (!keys.ollamaHost) return undefined;
  if (!keys.ollamaModel) {
    throw new Error('OLLAMA_MODEL must be set when OLLAMA_HOST is configured.');
  }
  return new OllamaProvider(keys.ollamaHost, keys.ollamaModel);
}

/**
 * Primary-then-fallback composition (distinct from evaluateMultiLlmConsensus's
 * "both must agree" gate in consensus.ts) — for a use case like marketing copy
 * generation, where availability matters more than a second opinion: try
 * `primary`, and only on a thrown error (timeout, 429, 5xx — the same
 * transient/non-transient split each provider already retries internally)
 * fall through to `fallback`. If `fallback` also throws, its error is what
 * surfaces, since it's the more recent/relevant failure for the caller to log.
 */
class FallbackAiProvider implements AiProvider {
  readonly name: AiProviderName;

  constructor(
    private readonly primary: AiProvider,
    private readonly fallback: AiProvider,
  ) {
    this.name = primary.name;
  }

  async generateText(prompt: string, options?: GenerateOptions): Promise<string> {
    try {
      return await this.primary.generateText(prompt, options);
    } catch {
      return await this.fallback.generateText(prompt, options);
    }
  }
}

/** Composes two already-resolved (possibly undefined) providers into one
 * primary-with-fallback provider. Returns whichever single one exists if
 * only one is configured, and undefined if neither is. */
export function resolvePrimaryFallbackProvider(
  primary: AiProvider | undefined,
  fallback: AiProvider | undefined,
): AiProvider | undefined {
  if (primary && fallback) return new FallbackAiProvider(primary, fallback);
  return primary ?? fallback;
}
