import { describe, expect, it } from 'vitest';
import { GrammyError } from 'grammy';
import { classifyTelegramError } from './telegramErrorClassifier.js';

function grammyError(
  errorCode: number,
  description: string,
  parameters: Record<string, unknown> = {},
) {
  return new GrammyError(
    description,
    { ok: false, error_code: errorCode, description, parameters },
    'sendPhoto',
    {},
  );
}

describe('classifyTelegramError', () => {
  it('classifies 403 Forbidden (bot blocked/kicked) as permanent', () => {
    const result = classifyTelegramError(
      grammyError(403, 'Forbidden: bot was blocked by the user'),
    );
    expect(result.kind).toBe('permanent');
  });

  it('classifies a 400 "chat not found" as permanent', () => {
    const result = classifyTelegramError(grammyError(400, 'Bad Request: chat not found'));
    expect(result.kind).toBe('permanent');
  });

  it('classifies a 400 "user is deactivated" as permanent', () => {
    const result = classifyTelegramError(grammyError(400, 'Bad Request: user is deactivated'));
    expect(result.kind).toBe('permanent');
  });

  it('classifies an unrelated 400 as transient — fails open, never guesses permanent', () => {
    const result = classifyTelegramError(grammyError(400, 'Bad Request: message is too long'));
    expect(result.kind).toBe('transient');
  });

  it('classifies 429 as transient and extracts retry_after in milliseconds', () => {
    const result = classifyTelegramError(
      grammyError(429, 'Too Many Requests: retry after 60', { retry_after: 60 }),
    );
    expect(result).toMatchObject({ kind: 'transient', retryAfterMs: 60_000 });
  });

  it('classifies 429 as transient with no retryAfterMs when the hint is absent', () => {
    const result = classifyTelegramError(grammyError(429, 'Too Many Requests'));
    expect(result).toMatchObject({ kind: 'transient', retryAfterMs: undefined });
  });

  it('classifies a 5xx server error as transient', () => {
    const result = classifyTelegramError(grammyError(500, 'Internal Server Error'));
    expect(result.kind).toBe('transient');
  });

  it('classifies a plain network/timeout Error as transient', () => {
    const result = classifyTelegramError(new Error('fetch failed: ETIMEDOUT'));
    expect(result.kind).toBe('transient');
  });

  it('classifies a totally unrecognized thrown value as transient — fails open', () => {
    expect(classifyTelegramError('a string, not even an Error').kind).toBe('transient');
    expect(classifyTelegramError(undefined).kind).toBe('transient');
  });
});
