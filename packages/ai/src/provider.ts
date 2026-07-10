import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type AiProviderName = 'anthropic' | 'openai';

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

export interface AiProviderKeys {
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

/** Prefers Claude when both keys are present; falls back to whichever one exists. */
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
