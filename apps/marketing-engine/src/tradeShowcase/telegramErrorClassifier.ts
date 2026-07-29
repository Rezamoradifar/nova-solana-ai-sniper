import { GrammyError } from 'grammy';

/**
 * Classifies a Telegram send failure so broadcastWorker.ts knows whether to
 * mark the recipient permanently unreachable (never retried again) or treat
 * it as transient (retried with backoff, up to a cap). "Fail open" on
 * anything unrecognized — never silently drop a real user by guessing wrong
 * in the permanent direction.
 */
export type TelegramErrorClassification =
  | { kind: 'permanent'; reason: string }
  | { kind: 'transient'; reason: string; retryAfterMs?: number };

const CHAT_NOT_FOUND_RE = /chat not found/i;
const BOT_BLOCKED_RE = /bot was blocked by the user/i;
const USER_DEACTIVATED_RE = /user is deactivated/i;

/**
 * 403 Forbidden (blocked/kicked/deactivated the bot), or a 400 whose
 * description matches one of the well-known "this chat will never accept a
 * message again" shapes, are permanent — the user's telegramActive flag
 * flips false and no future broadcast will attempt this chat again. A 429
 * (rate-limited) is transient and carries Telegram's own retry_after hint.
 * Any 5xx, network/timeout error, or anything else unrecognized is treated
 * as transient — fail open, since a permanent misclassification is the one
 * mistake that silently and permanently loses a real, reachable user.
 */
export function classifyTelegramError(err: unknown): TelegramErrorClassification {
  if (err instanceof GrammyError) {
    if (err.error_code === 403) {
      return { kind: 'permanent', reason: `403 Forbidden: ${err.description}` };
    }
    if (
      err.error_code === 400 &&
      (CHAT_NOT_FOUND_RE.test(err.description) ||
        BOT_BLOCKED_RE.test(err.description) ||
        USER_DEACTIVATED_RE.test(err.description))
    ) {
      return { kind: 'permanent', reason: `400: ${err.description}` };
    }
    if (err.error_code === 429) {
      const retryAfterSec = err.parameters?.retry_after;
      return {
        kind: 'transient',
        reason: `429 Too Many Requests: ${err.description}`,
        retryAfterMs: retryAfterSec !== undefined ? retryAfterSec * 1000 : undefined,
      };
    }
    return { kind: 'transient', reason: `${err.error_code}: ${err.description}` };
  }

  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'transient', reason: message };
}
