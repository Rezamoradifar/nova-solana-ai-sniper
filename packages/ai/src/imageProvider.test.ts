import { describe, expect, it, vi } from 'vitest';

const geminiGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: geminiGenerateContent };
  },
}));

const { resolveGeminiImageProvider } = await import('./imageProvider.js');

describe('resolveGeminiImageProvider', () => {
  it('returns undefined when no key is configured', () => {
    expect(resolveGeminiImageProvider({})).toBeUndefined();
  });

  it('returns a gemini-image provider when a key is configured', () => {
    const provider = resolveGeminiImageProvider({ geminiApiKey: 'g' });
    expect(provider?.name).toBe('gemini-image');
  });
});

describe('GeminiImageProvider.generateImage', () => {
  it('decodes the base64 inline image data into a Buffer', async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71]); // PNG magic bytes
    geminiGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: pngBytes.toString('base64'), mimeType: 'image/png' } }],
          },
        },
      ],
    });

    const provider = resolveGeminiImageProvider({ geminiApiKey: 'g' })!;
    const result = await provider.generateImage('a blue circle');

    expect(result).toEqual(pngBytes);
  });

  it('throws a clear error when the response has no image part (e.g. a text-only refusal)', async () => {
    geminiGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'I cannot generate that image.' }] } }],
    });

    const provider = resolveGeminiImageProvider({ geminiApiKey: 'g' })!;
    await expect(provider.generateImage('prompt')).rejects.toThrow(/no image data/);
  });

  it('propagates a thrown API error (e.g. quota exceeded) rather than swallowing it', async () => {
    geminiGenerateContent.mockRejectedValue(new Error('429 quota exceeded'));

    const provider = resolveGeminiImageProvider({ geminiApiKey: 'g' })!;
    await expect(provider.generateImage('prompt')).rejects.toThrow('429 quota exceeded');
  });
});
