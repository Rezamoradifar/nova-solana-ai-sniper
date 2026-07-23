import { GoogleGenAI } from '@google/genai';

/**
 * Image-generation provider abstraction (2026-07-23) — same shape/convention
 * as AiProvider in provider.ts (a `name` + one async method), kept separate
 * because generating an image is a distinct capability from generating text:
 * a caller that only needs text scoring/copy should never need to know an
 * image provider exists, and vice versa.
 */
export interface ImageProvider {
  readonly name: 'gemini-image';
  /** Returns raw image bytes (PNG/JPEG, whatever the provider emits) —
   * callers that need a specific format/size re-encode via sharp themselves,
   * same convention cards/render.ts already uses for a fetched token logo. */
  generateImage(prompt: string): Promise<Buffer>;
}

const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
/** Image generation is meaningfully slower than the short text-scoring calls
 * riskScorer.ts makes (GEMINI_TIMEOUT_MS there is 15s) — 30s gives a real
 * generation a fair chance without leaving a hung request forever. */
const GEMINI_IMAGE_TIMEOUT_MS = 30_000;

class GeminiImageProvider implements ImageProvider {
  readonly name = 'gemini-image' as const;
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateImage(prompt: string): Promise<Buffer> {
    const response = await this.client.models.generateContent({
      model: GEMINI_IMAGE_MODEL,
      contents: prompt,
      config: { httpOptions: { timeout: GEMINI_IMAGE_TIMEOUT_MS } },
    });
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      // Verified live (2026-07-23): a quota-exhausted free-tier key throws
      // before ever reaching this point (a 429 from the API call itself) —
      // this specific error is for the other failure shape, a 200 response
      // that simply didn't include image data (e.g. a text-only refusal).
      throw new Error('Gemini image response contained no image data');
    }
    return Buffer.from(imagePart.inlineData.data, 'base64');
  }
}

/** Resolves a Gemini image provider whenever a Gemini API key is configured
 * — same "resolve if key present, caller decides what to do with a failed
 * call" convention as resolveGeminiProvider in provider.ts. A resolved
 * provider is not a guarantee of a successful call: Imagen/image-capable
 * Gemini models require a billing-enabled account even when the same key
 * already works for text (verified live 2026-07-23 — see marketing-engine's
 * own doc comments on this). Callers must treat generateImage as fallible
 * and have a non-AI fallback ready. */
export function resolveGeminiImageProvider(keys: {
  geminiApiKey?: string;
}): ImageProvider | undefined {
  return keys.geminiApiKey ? new GeminiImageProvider(keys.geminiApiKey) : undefined;
}
