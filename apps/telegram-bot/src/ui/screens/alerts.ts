import { navOnly } from '../keyboards.js';
import { fmtDate, escapeMd } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const MAX_SHOWN = 10;

const ACTION_LABELS: Record<string, string> = {
  'wallet.create': '👛 Wallet created',
  'wallet.import': '👛 Wallet imported',
  'auth.register': '🆕 Account created',
  'auth.login': '🔓 Logged in',
  'auth.login_failed': '⚠️ Failed login attempt',
  'referral.pro_unlocked': '🎉 Referral reward',
};

export async function renderAlerts(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const entries = await deps.prisma.auditLog.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: MAX_SHOWN,
  });

  let text = '🔔 *Alerts*\n\nRecent activity on your account:\n\n';

  if (entries.length === 0) {
    text += 'Nothing yet — activity like wallet changes and trades will show up here.';
  } else {
    text += entries
      .map(
        // Unmapped audit-log actions (e.g. "admin.snipe_paused_for_safety") are raw
        // internal identifiers containing "_" — unescaped, that reads as an
        // unterminated italic marker to Telegram's legacy Markdown parser and made
        // the whole Alerts screen fail to render (confirmed live, same bug class as
        // captions.ts's buildShareCaption).
        (e) => `${ACTION_LABELS[e.action] ?? `ℹ️ ${escapeMd(e.action)}`}\n${fmtDate(e.createdAt)}`,
      )
      .join('\n\n');
  }

  return { text, keyboard: navOnly('home') };
}
