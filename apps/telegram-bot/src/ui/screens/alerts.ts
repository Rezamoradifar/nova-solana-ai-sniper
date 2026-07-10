import { navOnly } from '../keyboards.js';
import { fmtDate } from '../format.js';
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
      .map((e) => `${ACTION_LABELS[e.action] ?? `ℹ️ ${e.action}`}\n${fmtDate(e.createdAt)}`)
      .join('\n\n');
  }

  return { text, keyboard: navOnly('home') };
}
